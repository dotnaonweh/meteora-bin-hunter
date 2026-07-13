import { LAMPORTS_PER_SOL } from '../constants/index.js';
import type { SolAmount } from '../types/domain.js';

export function shortKey(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/** The single source of truth for rendering a SolAmount. The original inlined
 *  this ternary chain in four separate menu builders. */
export function solLabel(amount: SolAmount): string {
  switch (amount.kind) {
    case 'max':
      return 'MAX SOL';
    case 'percent':
      return `${amount.percent}% balance`;
    case 'fixed':
      return `${amount.sol} SOL`;
  }
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
}

export function signed(n: number, digits = 4): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

export function ms(n: number): string {
  return n === Number.POSITIVE_INFINITY ? 'timeout' : `${Math.round(n)}ms`;
}
