import { Connection } from '@solana/web3.js';
import type { Config, RpcEndpointConfig } from '../../config/index.js';
import { classify, fatal } from '../../core/errors.js';
import { CircuitBreaker } from '../../net/circuit-breaker.js';
import { withRetry } from '../../net/retry.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';

interface Endpoint {
  readonly config: RpcEndpointConfig;
  readonly connection: Connection;
  readonly breaker: CircuitBreaker;
  latencyMs: number;
  healthy: boolean;
}

/**
 * Pool of RPC endpoints with latency scoring, health checks and failover.
 *
 * The original picked one endpoint at boot with a single `getSlot` ping and
 * never revisited that decision: if the winner degraded an hour later, the bot
 * degraded with it and had no path back. Here every endpoint is continuously
 * scored, each is guarded by its own circuit breaker, and `execute()`
 * transparently fails over to the next healthy endpoint.
 */
export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly log: Logger;
  private healthTimer?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.log = logger.child({ module: 'rpc' });
    this.endpoints = cfg.rpc.endpoints.map((config) => ({
      config,
      connection: new Connection(config.url, {
        commitment: cfg.rpc.commitment,
        wsEndpoint: config.wsUrl,
        confirmTransactionInitialTimeout: cfg.tx.confirmTimeoutMs,
        // web3.js uses cross-fetch/node-fetch under the hood; disabling its own
        // retries lets our classified retry policy own the decision.
        disableRetryOnRateLimit: true,
      }),
      breaker: new CircuitBreaker({
        name: config.label,
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
        successThreshold: 2,
        onStateChange: (from, to) => {
          this.log.warn('circuit state change', { endpoint: config.label, from, to });
          this.metrics.increment(`rpc.breaker.${to}`);
        },
      }),
      latencyMs: Number.POSITIVE_INFINITY,
      healthy: true,
    }));
  }

  /** The current best endpoint: healthy, breaker closed, lowest latency. */
  get primary(): Connection {
    return this.best().connection;
  }

  get primaryLabel(): string {
    return this.best().config.label;
  }

  /** The websocket endpoint backing the primary connection. */
  get primaryWsUrl(): string {
    return this.best().config.wsUrl;
  }

  private best(): Endpoint {
    let chosen: Endpoint | undefined;
    for (const ep of this.endpoints) {
      if (!ep.healthy || !ep.breaker.canAttempt()) continue;
      if (!chosen || ep.latencyMs < chosen.latencyMs) chosen = ep;
    }
    // Everything is down: fall back to the least-bad endpoint rather than
    // throwing, so a transient total outage degrades instead of crashing.
    return chosen ?? this.endpoints[0]!;
  }

  private ordered(): Endpoint[] {
    return [...this.endpoints].sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      return a.latencyMs - b.latencyMs;
    });
  }

  /**
   * Runs an RPC call against the best endpoint, retrying transient failures and
   * failing over to the next endpoint when one is exhausted.
   */
  async execute<T>(name: string, fn: (conn: Connection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const candidates = this.ordered();
    let lastError: unknown;

    for (const ep of candidates) {
      if (!ep.breaker.canAttempt()) continue;

      const started = performance.now();
      try {
        const result = await withRetry(() => ep.breaker.execute(() => fn(ep.connection)), {
          maxAttempts: this.cfg.rpc.maxRetries + 1,
          baseDelayMs: 200,
          maxDelayMs: 3_000,
          signal,
          onRetry: (attempt, delayMs) => {
            this.metrics.increment('rpc.retries');
            this.log.warn('retrying rpc call', { rpc: name, endpoint: ep.config.label, attempt, delayMs: Math.round(delayMs) });
          },
        });
        const elapsed = performance.now() - started;
        this.metrics.observe('rpc.latency', elapsed);
        this.metrics.increment('rpc.calls');
        ep.latencyMs = ep.latencyMs === Number.POSITIVE_INFINITY ? elapsed : ep.latencyMs * 0.7 + elapsed * 0.3;
        return result;
      } catch (e) {
        lastError = e;
        const err = classify(e);
        this.metrics.increment('rpc.errors');
        // A recoverable error is the chain rejecting our request (e.g. bad
        // account). Failing over would just ask a different node the same
        // question and get the same answer, so surface it immediately.
        if (err.severity === 'recoverable') throw err;
        this.log.warn('endpoint failed, trying next', { rpc: name, endpoint: ep.config.label, err: err.message });
        this.metrics.increment('rpc.failovers');
      }
    }
    throw classify(lastError ?? fatal('rpc.exhausted', 'All RPC endpoints failed'));
  }

  /** Probe every endpoint once and record latency. */
  async healthCheck(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async (ep) => {
        const started = performance.now();
        try {
          await ep.connection.getSlot(this.cfg.rpc.commitment);
          const elapsed = performance.now() - started;
          ep.latencyMs = ep.latencyMs === Number.POSITIVE_INFINITY ? elapsed : ep.latencyMs * 0.5 + elapsed * 0.5;
          ep.healthy = true;
          this.metrics.gauge(`rpc.endpoint.${ep.config.label}.latencyMs`, ep.latencyMs);
        } catch (e) {
          ep.healthy = false;
          ep.latencyMs = Number.POSITIVE_INFINITY;
          this.log.warn('endpoint unhealthy', { endpoint: ep.config.label, err: classify(e).message });
        }
      }),
    );
    this.log.debug('health check complete', {
      primary: this.primaryLabel,
      endpoints: this.endpoints.map((e) => `${e.config.label}=${Math.round(e.latencyMs)}ms`).join(' '),
    });
  }

  /** Snapshot for the /rpc UI. */
  status(): ReadonlyArray<{ label: string; latencyMs: number; healthy: boolean; breaker: string }> {
    return this.ordered().map((e) => ({
      label: e.config.label,
      latencyMs: e.latencyMs,
      healthy: e.healthy,
      breaker: e.breaker.current,
    }));
  }

  startHealthChecks(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.healthCheck().catch((e: unknown) => {
        this.log.error('health check failed', { err: classify(e).message });
      });
    }, this.cfg.rpc.healthCheckIntervalMs);
    this.healthTimer.unref();
  }

  async close(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
}
