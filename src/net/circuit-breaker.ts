import { retryable } from '../core/errors.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  readonly name: string;
  /** Consecutive failures before the circuit opens. */
  readonly failureThreshold: number;
  /** How long to stay open before allowing a probe request. */
  readonly resetTimeoutMs: number;
  /** Consecutive successes in half-open before closing again. */
  readonly successThreshold: number;
  readonly onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

/**
 * Standard three-state breaker. Guards a single downstream (one RPC endpoint,
 * one HTTP host) so that a dead dependency fails fast instead of tying up the
 * event loop and burning the retry budget on every call.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  get current(): BreakerState {
    return this.state;
  }

  /** True when a call may proceed. Transitions open -> half-open on timeout. */
  canAttempt(now = Date.now()): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return true;
    if (now - this.openedAt >= this.opts.resetTimeoutMs) {
      this.transition('half-open');
      this.successes = 0;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.failures = 0;
        this.transition('closed');
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(now = Date.now()): void {
    if (this.state === 'half-open') {
      this.openedAt = now;
      this.transition('open');
      return;
    }
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) {
      this.openedAt = now;
      this.transition('open');
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw retryable('breaker.open', `Circuit "${this.opts.name}" is open`, { breaker: this.opts.name });
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    }
  }

  private transition(to: BreakerState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.opts.onStateChange?.(from, to);
  }
}
