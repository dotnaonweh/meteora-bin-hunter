import { PublicKey } from '@solana/web3.js';
import { classify } from '../../core/errors.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from './endpoint-pool.js';
import { decodeLbPair } from './lbpair-decoder.js';

export interface ActiveBinUpdate {
  readonly poolAddress: string;
  readonly activeId: number;
  readonly binStep: number;
  readonly slot: number;
  /** Local receive time, used to measure end-to-end websocket latency. */
  readonly receivedAt: number;
}

type Listener = (update: ActiveBinUpdate) => void;

interface Subscription {
  readonly poolAddress: string;
  subscriptionId: number | null;
  refCount: number;
  readonly listeners: Set<Listener>;
  lastActiveId: number | null;
  lastSlot: number;
}

/**
 * Manages `onAccountChange` subscriptions to LbPair accounts.
 *
 * Design notes:
 *  - **Ref-counted.** Two extreme sessions on the same pool share one socket
 *    subscription. The original had no sharing (and no websockets at all).
 *  - **Leak-free.** Every subscribe is matched by an unsubscribe on release and
 *    on shutdown; listeners are removed with the session that owns them. The
 *    original leaked a `setTimeout` chain per chat forever.
 *  - **Self-healing.** A heartbeat watches for silent sockets and forces a
 *    resubscribe; web3.js reconnects the underlying socket itself, but it does
 *    not tell us when a subscription has gone quiet.
 */
export class SubscriptionManager {
  private readonly subs = new Map<string, Subscription>();
  private readonly log: Logger;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly rpc: RpcPool,
    logger: Logger,
    private readonly metrics: Metrics,
    private readonly heartbeatIntervalMs = 30_000,
    private readonly stalenessThresholdMs = 120_000,
  ) {
    this.log = logger.child({ module: 'ws' });
  }

  /**
   * Subscribes `listener` to active-bin changes for `poolAddress`.
   * Returns a disposer; calling it twice is safe.
   */
  async subscribe(poolAddress: string, listener: Listener): Promise<() => Promise<void>> {
    let sub = this.subs.get(poolAddress);
    if (!sub) {
      sub = {
        poolAddress,
        subscriptionId: null,
        refCount: 0,
        listeners: new Set(),
        lastActiveId: null,
        lastSlot: 0,
      };
      this.subs.set(poolAddress, sub);
    }

    sub.listeners.add(listener);
    sub.refCount++;

    if (sub.subscriptionId === null) {
      await this.attach(sub);
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      sub.listeners.delete(listener);
      sub.refCount--;
      if (sub.refCount <= 0) await this.detach(sub);
    };
  }

  private async attach(sub: Subscription): Promise<void> {
    const conn = this.rpc.primary;
    const key = new PublicKey(sub.poolAddress);

    sub.subscriptionId = conn.onAccountChange(
      key,
      (accountInfo, ctx) => {
        const receivedAt = Date.now();
        this.metrics.increment('ws.updates');

        const decoded = decodeLbPair(accountInfo.data);
        if (!decoded) {
          // Layout changed or data truncated. Do not guess — let the poll
          // fallback in the session read the value authoritatively.
          this.metrics.increment('ws.decodeFailures');
          this.log.warn('failed to decode lbPair account', { pool: sub.poolAddress });
          return;
        }

        sub.lastSlot = ctx.slot;

        // Suppress no-op pushes: the LbPair account is written on every swap,
        // but only a change in activeId can alter a rebalance decision. This
        // is the difference between waking the state machine on every trade in
        // the pool and waking it only when the bin actually moves.
        if (sub.lastActiveId === decoded.activeId) {
          this.metrics.increment('ws.suppressed');
          return;
        }
        sub.lastActiveId = decoded.activeId;

        const update: ActiveBinUpdate = {
          poolAddress: sub.poolAddress,
          activeId: decoded.activeId,
          binStep: decoded.binStep,
          slot: ctx.slot,
          receivedAt,
        };
        this.metrics.increment('ws.binChanges');

        for (const l of sub.listeners) {
          try {
            l(update);
          } catch (e) {
            // A throwing listener must never kill the socket callback.
            this.log.error('subscription listener threw', { pool: sub.poolAddress, err: classify(e).message });
          }
        }
      },
      { commitment: 'processed' },
    );

    this.metrics.gauge('ws.subscriptions', this.subs.size);
    this.log.info('subscribed to pool', { pool: sub.poolAddress, subId: sub.subscriptionId });
  }

  private async detach(sub: Subscription): Promise<void> {
    this.subs.delete(sub.poolAddress);
    if (sub.subscriptionId === null) return;
    try {
      await this.rpc.primary.removeAccountChangeListener(sub.subscriptionId);
      this.log.info('unsubscribed from pool', { pool: sub.poolAddress });
    } catch (e) {
      this.log.warn('unsubscribe failed', { pool: sub.poolAddress, err: classify(e).message });
    } finally {
      sub.subscriptionId = null;
      sub.listeners.clear();
      this.metrics.gauge('ws.subscriptions', this.subs.size);
    }
  }

  /** Last activeId seen on the socket, or null if none yet. */
  lastKnownActiveId(poolAddress: string): number | null {
    return this.subs.get(poolAddress)?.lastActiveId ?? null;
  }

  startHeartbeat(): void {
    if (this.heartbeat || this.closed) return;
    this.heartbeat = setInterval(() => {
      void this.checkLiveness();
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  /**
   * A subscription that has produced no update for longer than the staleness
   * threshold is presumed dead (web3.js can silently drop a subscription across
   * a reconnect). Re-attach it. Pools genuinely idle for that long re-attach
   * harmlessly.
   */
  private async checkLiveness(): Promise<void> {
    let currentSlot: number;
    try {
      currentSlot = await this.rpc.execute('getSlot', (c) => c.getSlot('processed'));
    } catch {
      return; // RPC pool already logged and will fail over
    }

    for (const sub of this.subs.values()) {
      if (sub.subscriptionId === null) continue;
      // Slots advance ~2.5/sec; if our last seen slot is far behind the chain
      // head, we are not receiving pushes.
      const slotsBehind = currentSlot - sub.lastSlot;
      const secondsBehind = slotsBehind * 0.4;
      if (sub.lastSlot > 0 && secondsBehind * 1000 > this.stalenessThresholdMs) {
        this.log.warn('subscription stale, resubscribing', {
          pool: sub.poolAddress,
          slotsBehind,
        });
        this.metrics.increment('ws.reconnects');
        const id = sub.subscriptionId;
        sub.subscriptionId = null;
        try {
          await this.rpc.primary.removeAccountChangeListener(id);
        } catch {
          /* already gone */
        }
        await this.attach(sub);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    await Promise.all([...this.subs.values()].map((s) => this.detach(s)));
    this.subs.clear();
  }
}
