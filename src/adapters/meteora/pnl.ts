import type { HttpClient } from '../../net/http.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { PositionPnl } from '../../types/domain.js';

const DEFAULT_BASE_URL = 'https://dlmm.datapi.meteora.ag';

/** Shape we rely on from the datapi response. Everything is optional because it
 *  is an external API we do not control — we validate, we do not assume. */
interface RawPnlResponse {
  readonly positions?: ReadonlyArray<{
    readonly pnlUsd?: unknown;
    readonly pnlSol?: unknown;
    readonly pnlPctChange?: unknown;
    readonly unrealizedPnl?: {
      readonly balancesSol?: unknown;
      readonly unclaimedFeeTokenX?: { readonly amountSol?: unknown };
      readonly unclaimedFeeTokenY?: { readonly amountSol?: unknown };
    };
  }>;
}

/** Coerces an unknown to a finite number, defaulting to 0.
 *  The original called `parseFloat` on untrusted fields and could propagate NaN
 *  straight into a `.toFixed()` in the UI. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface CacheEntry {
  readonly value: PositionPnl | null;
  readonly at: number;
}

/**
 * Client for Meteora's DLMM PnL API.
 *
 * Adds a short TTL cache plus in-flight deduplication: tapping Refresh three
 * times used to fire three identical upstream requests over three fresh TLS
 * connections.
 */
export class PnlClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly http: HttpClient,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly ttlMs = 15_000,
    private readonly baseUrl = DEFAULT_BASE_URL,
  ) {}

  async fetch(poolAddress: string, walletPubkey: string, signal?: AbortSignal): Promise<PositionPnl | null> {
    const key = `${poolAddress}:${walletPubkey}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      this.metrics.cache('pnl', true);
      return cached.value;
    }
    this.metrics.cache('pnl', false);

    const url = `${this.baseUrl}/positions/${encodeURIComponent(poolAddress)}/pnl?user=${encodeURIComponent(walletPubkey)}&status=open`;

    try {
      const data = await this.http.json<RawPnlResponse>({
        url,
        signal,
        dedupeKey: key,
      });

      const first = data.positions?.[0];
      const value: PositionPnl | null = first
        ? {
            pnlSol: toNumber(first.pnlSol),
            pnlUsd: toNumber(first.pnlUsd),
            pnlPctChange: toNumber(first.pnlPctChange),
            unrealizedPnlSol: toNumber(first.unrealizedPnl?.balancesSol),
            unclaimedFeeSolX: toNumber(first.unrealizedPnl?.unclaimedFeeTokenX?.amountSol),
            unclaimedFeeSolY: toNumber(first.unrealizedPnl?.unclaimedFeeTokenY?.amountSol),
          }
        : null;

      this.cache.set(key, { value, at: Date.now() });
      this.evict();
      return value;
    } catch (e) {
      // PnL is decorative. A failure here must never break the position view —
      // but it must still be logged, not swallowed.
      this.log.warn('pnl fetch failed', { pool: poolAddress, err: e instanceof Error ? e.message : String(e) });
      this.metrics.increment('pnl.errors');
      return null;
    }
  }

  /** Bounds the cache. Without this, a long-lived process accumulates one entry
   *  per (pool, wallet) pair seen — a slow leak. */
  private evict(): void {
    if (this.cache.size <= 256) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
  }
}
