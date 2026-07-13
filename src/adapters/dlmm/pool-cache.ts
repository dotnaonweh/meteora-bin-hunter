import DLMM from '@meteora-ag/dlmm';
import { PublicKey } from '@solana/web3.js';
import { DLMM_PROGRAM_ID } from '../../constants/index.js';
import { classify, recoverable } from '../../core/errors.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from '../../providers/rpc/endpoint-pool.js';

interface CacheEntry {
  readonly pool: DLMM;
  /** Monotonic ms of the last successful refetchStates(). */
  lastRefresh: number;
  /** Set when a websocket push tells us the pool changed. */
  dirty: boolean;
  refCount: number;
}

export interface PoolCacheOptions {
  /** Max age before a read forces a refetch, even if no push arrived. */
  readonly maxStalenessMs: number;
  /** Entries unused for this long are evicted. */
  readonly idleEvictionMs: number;
  readonly maxEntries: number;
}

/**
 * Caches `DLMM` pool objects.
 *
 * This is the single largest efficiency change in the rewrite. The original
 * called `DLMM.create()` — which fetches the lbPair account, its bin arrays and
 * both token mints — on *every* operation, then `refetchStates()` on top. A
 * single extreme-mode rebalance cycle constructed the same pool 4-6 times.
 *
 * Here a pool is constructed once and refreshed only when:
 *   - a websocket push marked it dirty (`invalidate`), or
 *   - it has aged past `maxStalenessMs`, or
 *   - a caller explicitly demands fresh state before signing.
 *
 * Concurrent `get()` calls for the same pool share one in-flight construction,
 * so a burst of events cannot stampede the RPC.
 */
export class PoolCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<DLMM>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private evictionTimer?: NodeJS.Timeout;
  private readonly lastAccess = new Map<string, number>();

  constructor(
    private readonly rpc: RpcPool,
    logger: Logger,
    private readonly metrics: Metrics,
    private readonly opts: PoolCacheOptions = {
      maxStalenessMs: 10_000,
      idleEvictionMs: 15 * 60_000,
      maxEntries: 256,
    },
  ) {
    this.log = logger.child({ module: 'poolcache' });
  }

  /**
   * Validates that an address is actually a DLMM pool before we ever send funds
   * to it. The original sent liquidity to whatever base58 string it scraped out
   * of a message, with no ownership check at all.
   */
  private async assertIsPool(address: PublicKey): Promise<void> {
    const info = await this.rpc.execute('getAccountInfo', (c) => c.getAccountInfo(address));
    if (!info) {
      throw recoverable('pool.notFound', 'That address does not exist on-chain.');
    }
    if (info.owner.toBase58() !== DLMM_PROGRAM_ID) {
      throw recoverable(
        'pool.notDlmm',
        'That address is not a Meteora DLMM pool. Refusing to send funds to it.',
        { owner: info.owner.toBase58() },
      );
    }
  }

  /** Returns a pool, constructing it on first use. */
  async get(address: string): Promise<DLMM> {
    this.lastAccess.set(address, Date.now());

    const entry = this.entries.get(address);
    if (entry) {
      this.metrics.cache('pool', true);
      return entry.pool;
    }

    const pending = this.inflight.get(address);
    if (pending) {
      this.metrics.cache('pool', true);
      return pending;
    }

    this.metrics.cache('pool', false);
    const build = this.build(address);
    this.inflight.set(address, build);
    try {
      return await build;
    } finally {
      this.inflight.delete(address);
    }
  }

  private async build(address: string): Promise<DLMM> {
    const key = new PublicKey(address);
    await this.assertIsPool(key);

    const pool = await this.metrics.time('dlmm.create', () =>
      this.rpc.execute('DLMM.create', (conn) => DLMM.create(conn, key)),
    );

    this.evictIfNeeded();
    this.entries.set(address, { pool, lastRefresh: Date.now(), dirty: false, refCount: 0 });
    this.log.debug('pool constructed', { pool: address, binStep: pool.lbPair.binStep });
    return pool;
  }

  /**
   * Returns a pool whose on-chain state is fresh enough to build a transaction
   * against. Refreshes only when dirty or stale — and coalesces concurrent
   * refreshes of the same pool into one RPC round.
   */
  async getFresh(address: string, force = false): Promise<DLMM> {
    const pool = await this.get(address);
    const entry = this.entries.get(address);
    if (!entry) return pool;

    const age = Date.now() - entry.lastRefresh;
    const needsRefresh = force || entry.dirty || age > this.opts.maxStalenessMs;
    if (!needsRefresh) {
      this.metrics.cache('poolState', true);
      return pool;
    }
    this.metrics.cache('poolState', false);

    const existing = this.refreshing.get(address);
    if (existing) {
      await existing;
      return pool;
    }

    const refresh = this.metrics
      .time('dlmm.refetchStates', () => this.rpc.execute('refetchStates', () => pool.refetchStates()))
      .then(() => {
        entry.lastRefresh = Date.now();
        entry.dirty = false;
      })
      .finally(() => {
        this.refreshing.delete(address);
      });

    this.refreshing.set(address, refresh);
    await refresh;
    return pool;
  }

  /** Marks a pool's cached state as out of date. Called from websocket pushes. */
  invalidate(address: string): void {
    const entry = this.entries.get(address);
    if (entry) entry.dirty = true;
  }

  /**
   * The active bin id straight from cached state — no RPC.
   * Returns null when the pool is not cached yet.
   */
  cachedActiveBin(address: string): number | null {
    return this.entries.get(address)?.pool.lbPair.activeId ?? null;
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.opts.maxEntries) return;

    // Evict the least recently accessed entry.
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, at] of this.lastAccess) {
      if (!this.entries.has(key)) continue;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.lastAccess.delete(oldestKey);
      this.metrics.increment('cache.pool.evictions');
    }
  }

  /** Drops pools nobody has touched recently, bounding memory for a process that
   *  sees thousands of distinct pools over a long uptime. */
  startEviction(intervalMs = 60_000): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      const cutoff = Date.now() - this.opts.idleEvictionMs;
      for (const [address, at] of this.lastAccess) {
        if (at > cutoff) continue;
        const entry = this.entries.get(address);
        if (entry && entry.refCount > 0) continue; // pinned by a live session
        this.entries.delete(address);
        this.lastAccess.delete(address);
        this.metrics.increment('cache.pool.evictions');
      }
      this.metrics.gauge('cache.pool.size', this.entries.size);
    }, intervalMs);
    this.evictionTimer.unref();
  }

  /** Pins a pool so eviction cannot drop it while a session is running. */
  pin(address: string): void {
    const entry = this.entries.get(address);
    if (entry) entry.refCount++;
  }

  unpin(address: string): void {
    const entry = this.entries.get(address);
    if (entry && entry.refCount > 0) entry.refCount--;
  }

  close(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }
    this.entries.clear();
    this.lastAccess.clear();
    this.inflight.clear();
    this.refreshing.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Surface classify() on construction errors for callers that want the reason. */
  static describeError(e: unknown): string {
    return classify(e).message;
  }
}
