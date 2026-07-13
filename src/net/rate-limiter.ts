import { sleep } from './retry.js';

/**
 * Token-bucket limiter.
 *
 * Tokens are computed lazily from elapsed time rather than refilled by an
 * interval timer — no background timer per limiter, and an idle limiter costs
 * nothing. Waiters are queued FIFO so a burst cannot starve an early caller.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  /** Non-blocking check. Consumes a token if one is available. */
  tryAcquire(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Blocks until a token is available. Provides backpressure to callers. */
  async acquire(signal?: AbortSignal): Promise<void> {
    this.queue++;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const now = Date.now();
        this.refill(now);
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const deficit = 1 - this.tokens;
        const waitMs = Math.max(5, Math.ceil((deficit / this.refillPerSec) * 1000));
        await sleep(waitMs, signal);
      }
    } finally {
      this.queue--;
    }
  }

  get pending(): number {
    return this.queue;
  }
}
