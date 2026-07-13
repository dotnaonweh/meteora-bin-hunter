import { Agent, request } from 'undici';
import { classify, recoverable, retryable } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { withRetry } from './retry.js';

export interface HttpClientOptions {
  readonly connections: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface HttpRequest {
  readonly method?: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Requests sharing a dedupe key that are in flight simultaneously resolve
   *  from a single upstream call. Only safe for idempotent reads. */
  readonly dedupeKey?: string;
  readonly timeoutMs?: number;
}

/**
 * HTTP client over a pooled keep-alive agent.
 *
 * The original opened a fresh TLS connection for every Telegram call and every
 * PnL fetch (`https.get` with no agent) — a full handshake on the hot path. One
 * pooled agent amortises that away entirely.
 */
export class HttpClient {
  private readonly agent: Agent;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly log: Logger;

  constructor(private readonly opts: HttpClientOptions) {
    this.log = opts.logger.child({ module: 'http' });
    this.agent = new Agent({
      connections: opts.connections,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      // Fail fast on a dead host rather than hanging the caller.
      connectTimeout: 5_000,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });
  }

  /**
   * Performs a JSON request with retry/backoff and in-flight deduplication.
   * The caller supplies the expected shape; we validate it is an object before
   * handing it back, so a malformed upstream cannot masquerade as valid data.
   */
  async json<T>(req: HttpRequest): Promise<T> {
    if (req.dedupeKey) {
      const existing = this.inflight.get(req.dedupeKey);
      if (existing) {
        this.opts.metrics.cache('http.dedupe', true);
        return existing as Promise<T>;
      }
      this.opts.metrics.cache('http.dedupe', false);
    }

    const run = this.execute<T>(req);

    if (req.dedupeKey) {
      const key = req.dedupeKey;
      this.inflight.set(key, run);
      // Always clear, success or failure — otherwise a rejected promise would
      // be served to every future caller of this key (a classic dedupe leak).
      run.catch(() => {}).finally(() => {
        this.inflight.delete(key);
      });
    }
    return run;
  }

  private async execute<T>(req: HttpRequest): Promise<T> {
    const method = req.method ?? 'GET';
    const started = performance.now();

    try {
      return await withRetry(
        async () => {
          const body = req.body === undefined ? undefined : JSON.stringify(req.body);
          const res = await request(req.url, {
            method,
            dispatcher: this.agent,
            signal: req.signal,
            headersTimeout: req.timeoutMs ?? this.opts.timeoutMs,
            bodyTimeout: req.timeoutMs ?? this.opts.timeoutMs,
            headers: body
              ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
              : undefined,
            body,
          });

          // The body MUST be drained even on error paths, or the pooled socket
          // is never returned to the agent and the pool starves.
          const text = await res.body.text();

          if (res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 408) {
            throw retryable('http.status', `HTTP ${res.statusCode} from ${hostOf(req.url)}`, {
              status: res.statusCode,
            });
          }
          if (res.statusCode >= 400) {
            throw recoverable('http.status', `HTTP ${res.statusCode} from ${hostOf(req.url)}`, {
              status: res.statusCode,
              body: text.slice(0, 200),
            });
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch (e) {
            throw recoverable('http.badJson', `Malformed JSON from ${hostOf(req.url)}`, {}, e);
          }
          if (parsed === null || typeof parsed !== 'object') {
            throw recoverable('http.badShape', `Expected a JSON object from ${hostOf(req.url)}`);
          }
          return parsed as T;
        },
        {
          maxAttempts: this.opts.maxRetries + 1,
          baseDelayMs: 200,
          maxDelayMs: 4_000,
          signal: req.signal,
          onRetry: (attempt, delayMs, error) => {
            this.opts.metrics.increment('http.retries');
            this.log.warn('retrying request', {
              host: hostOf(req.url),
              attempt,
              delayMs: Math.round(delayMs),
              ...(error instanceof Error ? { err: error.message } : {}),
            });
          },
        },
      );
    } catch (e) {
      this.opts.metrics.increment('http.errors');
      throw classify(e);
    } finally {
      this.opts.metrics.observe('http.latency', performance.now() - started);
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}
