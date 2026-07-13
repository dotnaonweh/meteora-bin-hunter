/** Wrapped SOL mint. The quote token for every pool this bot supports. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Basis points denominator used by the DLMM program for bin steps and bps. */
export const BASIS_POINTS = 10_000;

/** Full withdrawal, in bps. */
export const FULL_BPS = 10_000;

/** Matches the DLMM SDK's StrategyType enum. Duplicated as a const to keep
 *  pure modules (parsers, the state machine, tests) free of the SDK import. */
export const StrategyType = {
  Spot: 0,
  Curve: 1,
  BidAsk: 2,
} as const;

export type StrategyTypeValue = (typeof StrategyType)[keyof typeof StrategyType];

/** Base58 alphabet — excludes 0, O, I, l. */
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const BASE58_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
export const BASE58_SECRET_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** The DLMM program. Used to verify a pasted address is actually a pool
 *  before we send funds to it. */
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/**
 * Bin-width limits, from the DLMM program.
 *
 * A *classic* position spans at most 70 bins (`DEFAULT_BIN_PER_POSITION`), which
 * is where the familiar "-49%" ceiling comes from: 69 bins below the active one
 * at binStep 100 reaches exactly -49.7%.
 *
 * Wider ranges need a resizable *extended* position (`initializePosition2` +
 * `increasePositionLength2`), which goes up to 1400 bins — the same path the
 * official Meteora app uses for wide ranges.
 */
export const MAX_BINS_PER_POSITION = 70;
export const MAX_BINS_EXTENDED = 1400;
