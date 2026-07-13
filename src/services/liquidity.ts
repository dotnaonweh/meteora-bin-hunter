import type { Keypair } from '@solana/web3.js';
import type { Config } from '../config/index.js';
import { recoverable } from '../core/errors.js';
import type { DlmmClient } from '../adapters/dlmm/client.js';
import type { PoolCache } from '../adapters/dlmm/pool-cache.js';
import type { Logger } from '../observability/logger.js';
import type { PositionRegistry } from '../state/positions.js';
import type { WalletRegistry } from '../state/wallets.js';
import type { Preset, TrackedPosition } from '../types/domain.js';
import { rangeToBins, resolveSolAmount } from '../utils/parse.js';

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
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  /** Resolves a preset's sizing against the live balance, with a floor check. */
  private async sizePosition(owner: Keypair, preset: Preset, signal?: AbortSignal): Promise<number> {
    if (preset.sol.kind === 'fixed') {
      // Even a fixed size must be affordable.
      const balance = await this.dlmm.solBalance(owner.publicKey, signal);
      if (balance - this.cfg.wallet.feeReserveSol < preset.sol.sol) {
        throw recoverable(
          'liquidity.insufficientSol',
          `Insufficient SOL: need ${preset.sol.sol} + ${this.cfg.wallet.feeReserveSol} reserve, have ${balance.toFixed(4)}.`,
        );
      }
      return preset.sol.sol;
    }

    const balance = await this.dlmm.solBalance(owner.publicKey, signal);
    const sized = resolveSolAmount(preset.sol, balance, this.cfg.wallet.feeReserveSol);

    if (sized < 0.001) {
      throw recoverable(
        'liquidity.insufficientSol',
        `Insufficient SOL (${sized.toFixed(4)} usable). Need at least 0.001 plus a ${this.cfg.wallet.feeReserveSol} SOL fee reserve.`,
      );
    }
    return sized;
  }

  async addLiquidity(poolAddress: string, preset: Preset, signal?: AbortSignal): Promise<AddLiquidityResult> {
    const owner = this.wallets.requireActive();

    // `getFresh(force)` validates the address is a real DLMM pool before we
    // size anything or send funds anywhere.
    const pool = await this.pools.getFresh(poolAddress, true);
    const solUsed = await this.sizePosition(owner, preset, signal);

    const activeBinId = pool.lbPair.activeId;
    const bins = rangeToBins(preset.range, pool.lbPair.binStep);

    // Same geometry as the original: the range sits *below* the active bin, so
    // a SOL-only deposit is entirely on the quote side.
    const minBinId = activeBinId - bins;
    const maxBinId = activeBinId;

    const result = await this.dlmm.openPosition({
      poolAddress,
      owner,
      solAmount: solUsed,
      minBinId,
      maxBinId,
      strategy: preset.strategy,
      signal,
    });

    const tracked: TrackedPosition = {
      positionKey: result.positionKey,
      poolAddress,
      minBinId,
      maxBinId,
      solAmount: solUsed,
      rangePercent: preset.range,
      strategy: preset.strategy,
      addedAt: new Date().toISOString(),
      txHash: result.signature,
      walletId: this.wallets.activeMeta?.id ?? '',
      synced: false,
    };
    this.positions.upsert(tracked);

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
