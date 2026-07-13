import { classify } from '../../core/errors.js';
import { backoffDelay, sleep } from '../../net/retry.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { TgUpdate } from '../../types/telegram.js';
import type { TelegramApi } from './api.js';
import type { Router } from './router.js';

/**
 * Long-poll loop.
 *
 * Two differences from the original's `setTimeout(tgPoll, 1000)` recursion:
 *
 *  1. **No fixed 1s gap.** Long polling already blocks for up to 30s server-side;
 *     the extra sleep only added latency. We re-poll immediately and back off
 *     exponentially *only* on error.
 *
 *  2. **Backpressure.** The original fired every update handler without awaiting
 *     (`handleTgMessage(...).catch()`), so a burst of taps could launch unbounded
 *     concurrent chain operations against one wallet. Here updates from a single
 *     chat are processed in order, which is also what makes wallet operations
 *     safe: two conflicting commands can no longer interleave mid-transaction.
 */
export class TelegramPoller {
  private offset = 0;
  private running = false;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;

  constructor(
    private readonly api: TelegramApi,
    private readonly router: Router,
    private readonly log: Logger,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    let consecutiveErrors = 0;

    this.log.info('telegram poller started');

    while (this.running && !signal.aborted) {
      try {
        const updates = await this.api.getUpdates(this.offset, signal);
        consecutiveErrors = 0;

        if (updates.length > 0) {
          this.metrics.increment('telegram.updates', updates.length);
          // Advance the offset before handling, so a handler that throws cannot
          // cause the same update to be replayed forever.
          this.offset = (updates[updates.length - 1]?.update_id ?? this.offset - 1) + 1;
          await this.dispatch(updates);
        }
      } catch (e) {
        if (signal.aborted) break;

        const err = classify(e);
        consecutiveErrors++;
        this.metrics.increment('telegram.pollErrors');
        this.log.error('poll failed', { err: err.message, consecutiveErrors });

        const delay = backoffDelay(Math.min(consecutiveErrors, 6), 500, 30_000);
        await sleep(delay, signal).catch(() => {});
      }
    }
    this.log.info('telegram poller stopped');
  }

  /**
   * Updates are handled sequentially. Telegram delivers them in order, and
   * serialising here means one wallet cannot be driven by two concurrent
   * commands. Extreme Mode still runs independently in the background — it is
   * event-driven, not part of this loop.
   */
  private async dispatch(updates: readonly TgUpdate[]): Promise<void> {
    for (const update of updates) {
      if (this.abort.signal.aborted) return;
      const started = performance.now();
      try {
        if (update.message) await this.router.handleMessage(update.message);
        else if (update.callback_query) await this.router.handleCallback(update.callback_query);
      } catch (e) {
        // The router already handles and reports its own errors; anything
        // reaching here is a bug, and must not kill the loop.
        this.log.error('unhandled error in update dispatch', { err: classify(e).message });
      } finally {
        this.metrics.observe('telegram.handleDuration', performance.now() - started);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(new Error('shutting down'));
    await this.loop?.catch(() => {});
    this.router.dispose();
  }
}
