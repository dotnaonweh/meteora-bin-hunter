import type { Keypair } from '@solana/web3.js';
import type { Config } from '../../config/index.js';
import { StrategyType } from '../../constants/index.js';
import { classify } from '../../core/errors.js';
import { sleep } from '../../net/retry.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { SubscriptionManager } from '../../providers/rpc/subscriptions.js';
import type { DlmmClient } from '../../adapters/dlmm/client.js';
import type { PoolCache } from '../../adapters/dlmm/pool-cache.js';
import type { SolAmount } from '../../types/domain.js';
import { resolveSolAmount } from '../../utils/parse.js';
import { decide, singleBinRange, type ExtremePhase } from './machine.js';

export interface ExtremeEvents {
  onOpened(info: { positionKey: string; targetBinId: number; solUsed: number; signature: string; cycle: number }): void;
  onRebalanced(info: { targetBinId: number; signature: string | null }): void;
  onCycle(info: { cycle: number; reason: string; targetBinId: number; solUsed: number; signature: string }): void;
  onHalted(info: { reason: string; cycles: number }): void;
  onError(info: { message: string; fatal: boolean }): void;
}

export interface ExtremeSessionDeps {
  readonly dlmm: DlmmClient;
  readonly pools: PoolCache;
  readonly subscriptions: SubscriptionManager;
  readonly cfg: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface ExtremeSessionParams {
  readonly id: string;
  readonly poolAddress: string;
  readonly owner: Keypair;
  readonly solAmount: SolAmount;
  readonly events: ExtremeEvents;
}

/**
 * One Extreme Mode session: a 1-bin BidAsk position that is rebalanced as the
 * active bin moves across it.
 *
 * Three structural fixes over the original's `extremeMonitorTick` chain:
 *
 *  1. **Event-driven.** The original woke on a 2500ms `setTimeout` regardless of
 *     whether anything had changed. Here a websocket push on the LbPair account
 *     wakes the machine the moment the bin actually moves; the timer survives
 *     only as a fallback for when the socket is down.
 *
 *  2. **Real cancellation.** The original's Stop button set a flag and cleared a
 *     timer — but an in-flight tick kept running and could open a *brand new
 *     position after the user had stopped*. Every await here is threaded with an
 *     AbortSignal, and stop() waits for the in-flight cycle to unwind.
 *
 *  3. **Serialised.** A single `running` guard means a slow cycle can never
 *     overlap with the next wake-up, so two rebalances can never race on the
 *     same position.
 */
export class ExtremeSession {
  private phase: ExtremePhase = 'active';
  private targetBinId = 0;
  private positionKey = '';
  private cycleCount = 0;

  private readonly abort = new AbortController();
  private running = false;
  private pending = false;
  private lastEvalAt = 0;
  private inflight: Promise<void> = Promise.resolve();

  private unsubscribe?: () => Promise<void>;
  private fallbackTimer?: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(
    private readonly params: ExtremeSessionParams,
    private readonly deps: ExtremeSessionDeps,
  ) {
    this.log = deps.logger.child({ module: 'extreme', session: params.id, pool: params.poolAddress });
  }

  get snapshot(): { phase: ExtremePhase; cycleCount: number; targetBinId: number; positionKey: string } {
    return {
      phase: this.phase,
      cycleCount: this.cycleCount,
      targetBinId: this.targetBinId,
      positionKey: this.positionKey,
    };
  }

  get isRunning(): boolean {
    return !this.isStopped();
  }

  /**
   * Read `phase` through a method call, deliberately.
   *
   * TypeScript's control-flow analysis narrows `this.phase` from assignments
   * made earlier in a function body — but `stop()` can flip it to 'stopped'
   * *concurrently*, while this session is parked on an await. Comparing
   * `this.phase === 'stopped'` inline after such an assignment makes the
   * compiler believe the check is dead code (TS2367). It is not: it is the
   * cancellation check. Reading it here, where no narrowing applies, keeps the
   * check honest without casting the type away.
   */
  private isStopped(): boolean {
    return this.phase === 'stopped';
  }

  /** Opens the initial position and begins watching the pool. */
  async start(): Promise<void> {
    const signal = this.abort.signal;

    const solUsed = await this.resolveSol(signal);
    const pool = await this.deps.pools.getFresh(this.params.poolAddress, true);
    const activeBin = pool.lbPair.activeId;

    const result = await this.deps.dlmm.openPosition({
      poolAddress: this.params.poolAddress,
      owner: this.params.owner,
      solAmount: solUsed,
      ...singleBinRange(activeBin),
      strategy: StrategyType.BidAsk,
      signal,
    });

    this.positionKey = result.positionKey;
    this.targetBinId = result.minBinId;
    this.phase = 'active';
    this.deps.pools.pin(this.params.poolAddress);

    this.params.events.onOpened({
      positionKey: result.positionKey,
      targetBinId: this.targetBinId,
      solUsed,
      signature: result.signature,
      cycle: 0,
    });

    this.unsubscribe = await this.deps.subscriptions.subscribe(this.params.poolAddress, (update) => {
      this.deps.pools.invalidate(update.poolAddress);
      this.deps.metrics.observe('extreme.wsToWake', Date.now() - update.receivedAt);
      this.wake(update.activeId);
    });

    // Fallback poll. Only does work if the socket has gone quiet.
    this.fallbackTimer = setInterval(() => {
      void this.pollFallback();
    }, this.deps.cfg.extreme.pollIntervalMs);
    this.fallbackTimer.unref();

    this.log.info('extreme session started', { targetBinId: this.targetBinId, solUsed });
  }

  /**
   * Called on every websocket push. Cheap: if a cycle is already running we just
   * mark work pending rather than queueing another one.
   */
  private wake(currentBinId: number): void {
    if (this.isStopped()) return;

    if (this.running) {
      this.pending = true;
      return;
    }

    // `minEvalIntervalMs` defaults to the original 2500ms so out-of-the-box
    // behaviour is unchanged. Set it to 0 to let the socket drive rebalances at
    // slot latency — that is a strategy change, so it is opt-in.
    const sinceLast = Date.now() - this.lastEvalAt;
    const floor = this.deps.cfg.extreme.minEvalIntervalMs;
    if (floor > 0 && sinceLast < floor) {
      this.pending = true;
      const wait = floor - sinceLast;
      setTimeout(() => {
        if (this.pending && !this.running) void this.pollFallback();
      }, wait).unref();
      return;
    }

    this.inflight = this.evaluate(currentBinId);
  }

  /** Timer path: reads the active bin (from cache or the socket's last value). */
  private async pollFallback(): Promise<void> {
    if (this.isStopped() || this.running) return;
    try {
      const known = this.deps.subscriptions.lastKnownActiveId(this.params.poolAddress);
      const currentBinId = known ?? (await this.deps.dlmm.activeBinId(this.params.poolAddress));
      this.deps.metrics.increment('extreme.pollFallbacks');
      await this.evaluate(currentBinId);
    } catch (e) {
      this.reportError(e);
    }
  }

  /** Runs one decision. Serialised: never re-entered. */
  private async evaluate(currentBinId: number): Promise<void> {
    if (this.running || this.isStopped()) return;
    this.running = true;
    this.pending = false;
    this.lastEvalAt = Date.now();

    const started = performance.now();
    try {
      const decision = decide(
        { phase: this.phase, targetBinId: this.targetBinId, cycleCount: this.cycleCount },
        currentBinId,
        { maxCycles: this.deps.cfg.extreme.maxCycles },
      );

      switch (decision.kind) {
        case 'idle':
          break;
        case 'halt':
          await this.halt(decision.reason);
          break;
        case 'rebalance':
          await this.rebalance(currentBinId);
          break;
        case 'cycle':
          await this.cycle(decision.reason);
          break;
      }
    } catch (e) {
      this.reportError(e);
    } finally {
      this.deps.metrics.observe('extreme.evalDuration', performance.now() - started);
      this.running = false;
      // A push that arrived while we were busy still needs servicing.
      if (this.pending && !this.isStopped()) {
        this.pending = false;
        queueMicrotask(() => void this.pollFallback());
      }
    }
  }

  /** Left-OOR: price fell below our bin. Withdraw the token and re-add it to the
   *  target bin, then wait for price to come back. */
  private async rebalance(currentBinId: number): Promise<void> {
    const signal = this.abort.signal;
    this.log.info('out of range (left), rebalancing', { currentBinId, targetBinId: this.targetBinId });

    await this.deps.dlmm.removeAllLiquidity({
      poolAddress: this.params.poolAddress,
      owner: this.params.owner,
      positionKey: this.positionKey,
      close: false,
      signal,
    });

    const pool = await this.deps.pools.get(this.params.poolAddress);
    const tokens = this.deps.dlmm.tokensOf(pool);

    const balance = await this.deps.dlmm.waitForTokenBalance(this.params.owner.publicKey, tokens.baseMint, signal);

    if (balance.isZero()) {
      this.log.warn('no token balance after withdraw, waiting for price to return');
      this.phase = 'waiting';
      this.params.events.onRebalanced({ targetBinId: this.targetBinId, signature: null });
      return;
    }

    const signature = await this.deps.dlmm.addLiquidityToBin({
      poolAddress: this.params.poolAddress,
      owner: this.params.owner,
      positionKey: this.positionKey,
      binId: this.targetBinId,
      amount: balance,
      baseIsX: tokens.baseIsX,
      strategy: StrategyType.BidAsk,
      signal,
    });

    this.phase = 'waiting';
    this.deps.metrics.increment('extreme.rebalances');
    this.params.events.onRebalanced({ targetBinId: this.targetBinId, signature });
  }

  /** Close the position, then reopen a fresh 1-bin position at the new active bin. */
  private async cycle(reason: 'right-oor' | 'returned'): Promise<void> {
    const signal = this.abort.signal;
    this.phase = 'executing';
    this.cycleCount++;

    this.log.info('cycling position', { reason, cycle: this.cycleCount });

    await this.deps.dlmm.removeAllLiquidity({
      poolAddress: this.params.poolAddress,
      owner: this.params.owner,
      positionKey: this.positionKey,
      close: true,
      signal,
    });

    // Let the withdrawal settle before reading the balance back.
    await sleep(this.deps.cfg.extreme.settleDelayMs, signal);

    const solUsed = await this.resolveSol(signal);
    if (solUsed < this.deps.cfg.extreme.minSolBalance) {
      await this.halt(`SOL exhausted (${solUsed.toFixed(4)} SOL)`);
      return;
    }

    // Re-check for cancellation: the user may have hit Stop while the close was
    // confirming. Without this, the original would open a new position *after*
    // being stopped and leave it orphaned on-chain.
    signal.throwIfAborted();

    const pool = await this.deps.pools.getFresh(this.params.poolAddress, true);
    const activeBin = pool.lbPair.activeId;

    const result = await this.deps.dlmm.openPosition({
      poolAddress: this.params.poolAddress,
      owner: this.params.owner,
      solAmount: solUsed,
      ...singleBinRange(activeBin),
      strategy: StrategyType.BidAsk,
      signal,
    });

    this.positionKey = result.positionKey;
    this.targetBinId = result.minBinId;
    this.phase = 'active';

    this.deps.metrics.increment('extreme.cycles');
    this.params.events.onCycle({
      cycle: this.cycleCount,
      reason,
      targetBinId: this.targetBinId,
      solUsed,
      signature: result.signature,
    });
  }

  private async resolveSol(signal: AbortSignal): Promise<number> {
    if (this.params.solAmount.kind === 'fixed') return this.params.solAmount.sol;
    const balance = await this.deps.dlmm.solBalance(this.params.owner.publicKey, signal);
    return resolveSolAmount(this.params.solAmount, balance, this.deps.cfg.wallet.feeReserveSol);
  }

  private async halt(reason: string): Promise<void> {
    this.log.warn('halting session', { reason, cycles: this.cycleCount });
    this.params.events.onHalted({ reason, cycles: this.cycleCount });
    await this.stop();
  }

  private reportError(e: unknown): void {
    const err = classify(e);
    if (err.name === 'AbortError' || err.message === 'aborted') return; // expected on stop

    this.deps.metrics.increment('extreme.errors');
    this.log.error('session error', { err: err.message, code: err.code, severity: err.severity });

    // A fatal error must not leave the session spinning.
    if (err.severity === 'fatal') {
      this.params.events.onError({ message: err.message, fatal: true });
      void this.stop();
      return;
    }
    this.params.events.onError({ message: err.message, fatal: false });

    // Left-OOR handling failing means we could not re-add. Fall back to waiting
    // for price to return, exactly as the original did on its error path.
    if (this.phase === 'executing') this.phase = 'waiting';
  }

  /**
   * Stops the session and waits for any in-flight cycle to unwind.
   * Idempotent. The on-chain position is intentionally left open — the user
   * removes it explicitly from the Positions menu, same as before.
   */
  async stop(): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopped';

    this.abort.abort(new Error('session stopped'));

    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.unsubscribe) {
      await this.unsubscribe().catch(() => {});
      this.unsubscribe = undefined;
    }
    this.deps.pools.unpin(this.params.poolAddress);

    // Wait for the in-flight cycle so shutdown is deterministic.
    await this.inflight.catch(() => {});
    this.log.info('extreme session stopped', { cycles: this.cycleCount });
  }
}
