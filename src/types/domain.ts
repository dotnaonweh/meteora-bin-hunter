import type { StrategyTypeValue } from '../constants/index.js';

/** How much SOL a preset commits: a fixed amount, a percentage of usable
 *  balance, or everything usable. Kept as a tagged union so the three cases
 *  can never be confused at a call site (the original used `number | 'max' |
 *  '50%'` in one field and re-parsed it everywhere). */
export type SolAmount =
  | { readonly kind: 'fixed'; readonly sol: number }
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'max' };

export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly sol: SolAmount;
  /** Range below the active bin, in percent. */
  readonly range: number;
  readonly strategy: StrategyTypeValue;
}

export interface WalletMeta {
  readonly id: string;
  readonly name: string;
  readonly pubkey: string;
  /** Name of the env var holding the secret. The secret itself is never
   *  persisted to the state file. */
  readonly envKey: string;
}

export interface TrackedPosition {
  readonly positionKey: string;
  readonly poolAddress: string;
  readonly minBinId: number;
  readonly maxBinId: number;
  readonly solAmount: number;
  readonly rangePercent: number;
  readonly strategy: StrategyTypeValue | 'synced';
  readonly addedAt: string;
  readonly txHash: string;
  readonly walletId: string;
  readonly synced: boolean;
}

export interface PersistedState {
  wallets: Record<string, WalletMeta>;
  activeWalletId: string | null;
  positions: Record<string, TrackedPosition>;
  presets: Record<string, Preset>;
  activePresetId: string | null;
}

export function emptyState(): PersistedState {
  return {
    wallets: {},
    activeWalletId: null,
    positions: {},
    presets: {},
    activePresetId: null,
  };
}

export interface PositionPnl {
  readonly pnlSol: number;
  readonly pnlUsd: number;
  readonly pnlPctChange: number;
  readonly unrealizedPnlSol: number;
  readonly unclaimedFeeSolX: number;
  readonly unclaimedFeeSolY: number;
}

export interface PositionStatus extends TrackedPosition {
  readonly currentBin: number;
  readonly inRange: boolean;
  readonly pnl: PositionPnl | null;
}
