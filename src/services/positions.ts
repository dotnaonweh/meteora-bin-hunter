import type { PublicKey } from '@solana/web3.js';
import type { DlmmClient } from '../adapters/dlmm/client.js';
import type { PnlClient } from '../adapters/meteora/pnl.js';
import { recoverable } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import type { PositionRegistry } from '../state/positions.js';
import type { WalletRegistry } from '../state/wallets.js';
import type { PositionStatus, TrackedPosition } from '../types/domain.js';

export class PositionService {
  constructor(
    private readonly dlmm: DlmmClient,
    private readonly pnl: PnlClient,
    private readonly wallets: WalletRegistry,
    private readonly positions: PositionRegistry,
    private readonly log: Logger,
  ) {}

  /**
   * Live status for one position.
   *
   * The active bin and the PnL are independent reads, so they are issued
   * concurrently — the original awaited them in sequence, paying both latencies
   * back-to-back on every Refresh tap.
   */
  async status(positionKey: string, signal?: AbortSignal): Promise<PositionStatus> {
    const tracked = this.positions.get(positionKey);
    if (!tracked) throw recoverable('position.notTracked', 'Position not found.');

    const owner = this.wallets.activeMeta;

    const [currentBin, pnl] = await Promise.all([
      this.dlmm.activeBinId(tracked.poolAddress),
      owner ? this.pnl.fetch(tracked.poolAddress, owner.pubkey, signal) : Promise.resolve(null),
    ]);

    return {
      ...tracked,
      currentBin,
      inRange: currentBin >= tracked.minBinId && currentBin <= tracked.maxBinId,
      pnl,
    };
  }

  /**
   * Reconciles tracked positions against the chain: adopts positions opened
   * elsewhere (e.g. on the Meteora website) and drops ones already closed.
   */
  async sync(signal?: AbortSignal): Promise<{ total: number; added: number; removed: number }> {
    const owner = this.wallets.requireActive();
    const walletId = this.wallets.activeMeta?.id ?? '';

    const onChain = await this.dlmm.allPositions(owner.publicKey, signal);

    const reconciled = new Map<string, TrackedPosition>();
    for (const [positionKey, { poolAddress, position }] of onChain) {
      const existing = this.positions.get(positionKey);
      if (existing) {
        reconciled.set(positionKey, existing);
        continue;
      }
      reconciled.set(positionKey, adopt(positionKey, poolAddress, position, walletId));
    }

    const { added, removed } = this.positions.reconcile(reconciled);
    this.log.info('positions synced', { total: onChain.size, added, removed });
    return { total: onChain.size, added, removed };
  }
}

interface BinDatum {
  readonly binId: number;
  readonly positionYAmount: string | number;
}

/** Builds a TrackedPosition from on-chain data, in a single pass over the bins.
 *  The original made three passes (map for ids, reduce for Y, then Math.min/max
 *  with a spread — which also blows the stack on a wide position). */
function adopt(
  positionKey: string,
  poolAddress: string,
  position: { positionData: { positionBinData: readonly BinDatum[] } },
  walletId: string,
): TrackedPosition {
  const bins = position.positionData.positionBinData;

  let minBinId = Number.POSITIVE_INFINITY;
  let maxBinId = Number.NEGATIVE_INFINITY;
  let totalYLamports = 0;

  for (const bin of bins) {
    if (bin.binId < minBinId) minBinId = bin.binId;
    if (bin.binId > maxBinId) maxBinId = bin.binId;
    totalYLamports += Number(bin.positionYAmount) || 0;
  }

  const hasBins = bins.length > 0;

  return {
    positionKey,
    poolAddress,
    minBinId: hasBins ? minBinId : 0,
    maxBinId: hasBins ? maxBinId : 0,
    solAmount: Math.round((totalYLamports / 1e9) * 10_000) / 10_000,
    rangePercent: 0,
    strategy: 'synced',
    addedAt: new Date().toISOString(),
    txHash: 'synced',
    walletId,
    synced: true,
  };
}

export type { PublicKey };
