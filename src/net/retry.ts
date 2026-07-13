import { classify, isAppError } from '../core/errors.js';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULTS = { baseDelayMs: 150, maxDelayMs: 5_000 } as const;

/** Full-jitter exponential backoff (AWS's formulation): random over the whole
 *  window rather than `delay ± jitter`. Prevents a fleet of retries from
 *  re-synchronising into thundering herds after a shared outage. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * exponential;
}

/**
 * Abortable sleep.
 *
 * The timer is deliberately NOT unref'd. It is the only pending handle while a
 * retry backs off, so unref'ing it lets the event loop drain and the process
 * exit(0) mid-backoff — a 24/7 daemon would silently vanish on the first
 * transient error. Shutdown is handled by aborting `signal`, which clears the
 * timer and rejects immediately, so holding a ref costs nothing.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retries `fn` while the failure classifies as `retryable`.
 *
 * A `recoverable` or `fatal` error aborts immediately — retrying a rejected
 * input or a bad config only wastes rate-limit budget. This is why every error
 * is classified rather than blindly retried on any throw.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, signal, onRetry } = options;
  const baseDelayMs = options.baseDelayMs || DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs || DEFAULTS.maxDelayMs;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const err = classify(e);
      if (err.severity !== 'retryable' || attempt === maxAttempts - 1) throw err;

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(attempt + 1, delay, err);
      await sleep(delay, signal);
    }
  }
  throw isAppError(lastError) ? lastError : classify(lastError);
}
