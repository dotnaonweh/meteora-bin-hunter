import type { Keypair } from '@solana/web3.js';
import type { Config } from '../config/index.js';
import { MAX_BINS_EXTENDED } from '../constants/index.js';
import { classify, recoverable } from '../core/errors.js';
import type { DlmmClient } from '../adapters/dlmm/client.js';
import type { PoolCache } from '../adapters/dlmm/pool-cache.js';
import { estimateLpReserveSol } from '../adapters/dlmm/rent.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { RpcPool } from '../providers/rpc/endpoint-pool.js';
import type { PositionRegistry } from '../state/positions.js';
import type { WalletRegistry } from '../state/wallets.js';
import type { Preset } from '../types/domain.js';
import { binsToRange, rangeToBins, resolveSolAmount } from '../utils/parse.js';

/** Smallest deposit worth opening a position for. */
const MIN_LP_SOL = 0.001;

export interface AddLiquidityResult {
  readonly positionKey: string;
  readonly signature: string;
  readonly minBinId: number;
  readonly maxBinId: number;
  readonly activeBinId: number;
  readonly solUsed: number;
}

/**
 * Business logic for opening and closing LP positions.
 * Knows nothing about Telegram, and nothing about how RPC is transported.
 */
export class LiquidityService {
  constructor(
    private readonly dlmm: DlmmClient,
    private readonly pools: PoolCache,
    private readonly wallets: WalletRegistry,
    private readonly positions: PositionRegistry,
    private readonly rpc: RpcPool,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly metrics: Metrics,
  ) {}

  /**
   * Resolves a preset's sizing against the live balance.
   *
   * `reserveSol` is the SOL that must be left behind. For `max`/`N%` it is
   * priced from the actual range being opened, because rent scales with bin
   * count: a wide position plus brand-new bin arrays can need well over 1 SOL,
   * and v1's flat 0.08 reserve would size the deposit to eat the whole balance
   * and then fail for want of rent.
   */
  private async sizePosition(
    owner: Keypair,
    preset: Preset,
    reserveSol: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const balance = await this.dlmm.solBalance(owner.publicKey, signal);

    if (preset.sol.kind === 'fixed') {
      // Even a fixed size must be affordable alongside the reserve.
      if (balance - reserveSol < preset.sol.sol) {
        throw recoverable(
          'liquidity.insufficientSol',
          `Insufficient SOL: need ${preset.sol.sol} + ~${reserveSol.toFixed(4)} for rent/fees, have ${balance.toFixed(4)}.`,
        );
      }
      return preset.sol.sol;
    }

    const sized = resolveSolAmount(preset.sol, balance, reserveSol);

    if (sized < MIN_LP_SOL) {
      throw recoverable(
        'liquidity.insufficientSol',
        `Insufficient SOL (${sized.toFixed(4)} usable of ${balance.toFixed(4)}). ` +
          `This range needs ~${reserveSol.toFixed(4)} SOL for rent and fees.`,
      );
    }
    return sized;
  }

  async addLiquidity(poolAddress: string, preset: Preset, signal?: AbortSignal): Promise<AddLiquidityResult> {
    const owner = this.wallets.requireActive();

    // `getFresh(force)` validates the address is a real DLMM pool before we
    // size anything or send funds anywhere.
    const pool = await this.pools.getFresh(poolAddress, true);

    const activeBinId = pool.lbPair.activeId;
    const binStep = pool.lbPair.binStep;
    const bins = rangeToBins(preset.range, binStep);

    if (bins > MAX_BINS_EXTENDED) {
      // Fail here with something actionable rather than deep inside the SDK.
      // At a fine bin step a wide range is simply unreachable.
      throw recoverable(
        'liquidity.rangeTooWide',
        `-${preset.range}% needs ${bins} bins at this pool's bin step (${binStep}), ` +
          `over the ${MAX_BINS_EXTENDED}-bin limit. The widest this pool supports is ` +
          `about -${binsToRange(MAX_BINS_EXTENDED, binStep).toFixed(1)}%.`,
      );
    }

    // The range sits *below* the active bin, so a SOL-only deposit is entirely
    // on the quote side. `maxBinId` occupies one bin itself, so minBinId only
    // descends `bins - 1` further — v1 omitted the +1 and opened positions one
    // bin wider than requested.
    const maxBinId = activeBinId;
    const minBinId = activeBinId - bins + 1;

    // Price the reserve against this exact range before sizing the deposit.
    const reserveSol =
      preset.sol.kind === 'fixed'
        ? this.cfg.wallet.feeReserveSol
        : await estimateLpReserveSol(this.rpc, this.metrics, pool, minBinId, maxBinId, owner.publicKey, signal);

    const solUsed = await this.sizePosition(owner, preset, reserveSol, signal);

    const track = (positionKey: string, txHash: string): void => {
      this.positions.upsert({
        positionKey,
        poolAddress,
        minBinId,
        maxBinId,
        solAmount: solUsed,
        rangePercent: preset.range,
        strategy: preset.strategy,
        addedAt: new Date().toISOString(),
        txHash,
        walletId: this.wallets.activeMeta?.id ?? '',
        synced: false,
      });
    };

    let result;
    try {
      result = await this.dlmm.openPosition({
        poolAddress,
        owner,
        solAmount: solUsed,
        minBinId,
        maxBinId,
        strategy: preset.strategy,
        signal,
      });
    } catch (e) {
      // A wide range lands across many transactions. If it failed partway, the
      // position EXISTS and HOLDS FUNDS. Record it before rethrowing, or the bot
      // would forget about real money sitting on-chain and the user would have
      // no way to remove it from the UI.
      const err = classify(e);
      const partialKey = err.context.positionKey;
      if (err.code === 'position.partiallyFunded' && typeof partialKey === 'string') {
        track(partialKey, 'partial');
        this.log.error('recorded partially funded position so it is not lost', {
          position: partialKey,
          pool: poolAddress,
        });
      }
      throw err;
    }

    track(result.positionKey, result.signature);

    this.log.info('liquidity added', {
      pool: poolAddress,
      position: result.positionKey,
      solUsed,
      minBinId,
      maxBinId,
    });

    return { ...result, solUsed };
  }

  async removeLiquidity(positionKey: string, signal?: AbortSignal): Promise<string[]> {
    const tracked = this.positions.get(positionKey);
    if (!tracked) throw recoverable('position.notTracked', 'Position not found.');

    const owner = this.wallets.requireActive();

    // Guard against removing a position that belongs to a different wallet than
    // the one currently active — the original never checked this, so switching
    // wallets and hitting Remove would fail confusingly deep inside the SDK.
    if (tracked.walletId && this.wallets.activeMeta?.id !== tracked.walletId) {
      throw recoverable(
        'position.wrongWallet',
        'That position belongs to a different wallet. Switch to it first.',
      );
    }

    const signatures = await this.dlmm.removeAllLiquidity({
      poolAddress: tracked.poolAddress,
      owner,
      positionKey,
      close: true,
      signal,
    });

    this.positions.remove(positionKey);
    this.log.info('liquidity removed', { position: positionKey, signatures: signatures.length });
    return signatures;
  }
}
