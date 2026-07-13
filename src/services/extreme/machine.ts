/**
 * The Extreme Mode decision function — pure, synchronous, side-effect free.
 *
 * Extracting this is what makes the strategy testable. The predicates below are
 * a faithful, one-for-one port of the original `extremeMonitorTick`:
 *
 *   active  + current >  target  ->  close & reopen at the new active bin  ("right OOR")
 *   active  + current <  target  ->  withdraw & re-add into the target bin ("left OOR")
 *   active  + current == target  ->  do nothing
 *   waiting + current >= target  ->  close & reopen ("price came back")
 *   waiting + current <  target  ->  keep waiting
 *   executing / stopped          ->  do nothing (a cycle is already in flight)
 *
 * Nothing here talks to a chain, a clock, or a socket, so the behaviour can be
 * asserted exhaustively in unit tests.
 */

export type ExtremePhase =
  /** Position is open and sitting at the target bin. */
  | 'active'
  /** Liquidity is parked in the target bin, waiting for price to come back up. */
  | 'waiting'
  /** A cycle is in flight; no new decision may be taken. */
  | 'executing'
  | 'stopped';

export type ExtremeDecision =
  | { readonly kind: 'idle' }
  | { readonly kind: 'cycle'; readonly reason: 'right-oor' | 'returned' }
  | { readonly kind: 'rebalance' }
  | { readonly kind: 'halt'; readonly reason: string };

export interface ExtremeSnapshot {
  readonly phase: ExtremePhase;
  readonly targetBinId: number;
  readonly cycleCount: number;
}

export interface ExtremeLimits {
  /** Stop after this many cycles. 0 = unlimited. */
  readonly maxCycles: number;
}

/**
 * Decides what to do given the current active bin.
 *
 * `solBalance` is passed in (rather than fetched) to keep this pure; the caller
 * is responsible for supplying a recent value.
 */
export function decide(
  state: ExtremeSnapshot,
  currentBinId: number,
  limits: ExtremeLimits,
): ExtremeDecision {
  if (state.phase === 'stopped' || state.phase === 'executing') {
    return { kind: 'idle' };
  }

  // Circuit breaker: the original looped forever, paying fees on every cycle
  // with no cap and no way to bound the bleed.
  if (limits.maxCycles > 0 && state.cycleCount >= limits.maxCycles) {
    return { kind: 'halt', reason: `reached cycle limit (${limits.maxCycles})` };
  }

  if (state.phase === 'active') {
    if (currentBinId > state.targetBinId) return { kind: 'cycle', reason: 'right-oor' };
    if (currentBinId < state.targetBinId) return { kind: 'rebalance' };
    return { kind: 'idle' };
  }

  // phase === 'waiting'
  if (currentBinId >= state.targetBinId) return { kind: 'cycle', reason: 'returned' };
  return { kind: 'idle' };
}

/** Bins spanned by a 1-bin position. Extreme Mode always uses exactly one bin. */
export function singleBinRange(binId: number): { minBinId: number; maxBinId: number } {
  return { minBinId: binId, maxBinId: binId };
}
