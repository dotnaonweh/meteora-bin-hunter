import { classify } from './errors.js';
import type { Logger } from '../observability/logger.js';

type Hook = () => Promise<void> | void;

/**
 * Graceful shutdown.
 *
 * The original had no signal handling at all: SIGINT killed the process with
 * Extreme sessions mid-cycle, websockets open, and `data.json` potentially
 * half-written. Hooks run in reverse registration order (LIFO), so teardown
 * unwinds in the opposite order to construction.
 */
export class Lifecycle {
  private readonly hooks: Array<{ name: string; hook: Hook }> = [];
  private shuttingDown = false;

  constructor(
    private readonly log: Logger,
    private readonly timeoutMs = 15_000,
  ) {}

  onShutdown(name: string, hook: Hook): void {
    this.hooks.push({ name, hook });
  }

  /** Installs signal and last-resort error handlers. */
  install(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        this.log.info('signal received, shutting down', { signal });
        void this.shutdown(0);
      });
    }

    // An unhandled rejection means a promise error escaped every handler. That
    // is a bug — crash loudly rather than continuing in an unknown state with a
    // hot wallet loaded.
    process.on('unhandledRejection', (reason) => {
      this.log.error('unhandled promise rejection', { err: classify(reason).message });
      void this.shutdown(1);
    });

    process.on('uncaughtException', (err) => {
      this.log.error('uncaught exception', { err: err.message, stack: err.stack });
      void this.shutdown(1);
    });
  }

  async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const timer = setTimeout(() => {
      this.log.error('shutdown timed out, forcing exit');
      process.exit(code === 0 ? 1 : code);
    }, this.timeoutMs);
    timer.unref();

    for (const { name, hook } of [...this.hooks].reverse()) {
      try {
        await hook();
        this.log.debug('shutdown hook complete', { hook: name });
      } catch (e) {
        this.log.error('shutdown hook failed', { hook: name, err: classify(e).message });
      }
    }

    clearTimeout(timer);
    this.log.info('shutdown complete');
    process.exit(code);
  }
}
