import { BorshAccountsCoder } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import pkg from '@meteora-ag/dlmm';

const { IDL } = pkg as unknown as { IDL: Idl };

/**
 * Decodes the `activeId` field out of a raw LbPair account buffer.
 *
 * This is what makes websocket-driven rebalancing free: an account push already
 * carries the full account data, so the active bin can be read from the buffer
 * with zero additional RPC round trips. The original made 1-2 full RPC calls
 * (`DLMM.create` + `getActiveBin`) every 2.5s just to learn this one integer.
 */

// The account name differs across IDL generations ("LbPair" vs "lbPair").
// Resolve it once from the IDL rather than hardcoding a guess.
const ACCOUNT_NAME: string | undefined = (IDL.accounts ?? []).find((a) => /^lbPair$/i.test(a.name))?.name;

let coder: BorshAccountsCoder | undefined;

function getCoder(): BorshAccountsCoder {
  coder ??= new BorshAccountsCoder(IDL);
  return coder;
}

export interface DecodedLbPair {
  readonly activeId: number;
  readonly binStep: number;
}

/**
 * Field names depend on the IDL generation: Anchor's *new* IDL format (spec
 * 0.1.0, which the current DLMM program ships) preserves the on-chain snake_case
 * names, while the legacy format camelCased them. Read both rather than betting
 * on one — verified against mainnet: `active_id` is what actually comes back
 * today, and it matches `DLMM.create().lbPair.activeId` exactly.
 */
function readInt(decoded: Record<string, unknown>, snake: string, camel: string): number | null {
  const value = decoded[snake] ?? decoded[camel];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Returns null when the buffer cannot be decoded — a program upgrade that
 * changes the layout must degrade to the RPC fallback path, never crash the
 * subscription loop or, worse, yield a silently wrong bin id.
 */
export function decodeLbPair(data: Buffer): DecodedLbPair | null {
  if (!ACCOUNT_NAME) return null;
  try {
    const decoded = getCoder().decode<Record<string, unknown>>(ACCOUNT_NAME, data);
    const activeId = readInt(decoded, 'active_id', 'activeId');
    const binStep = readInt(decoded, 'bin_step', 'binStep');
    if (activeId === null || binStep === null) return null;
    return { activeId, binStep };
  } catch {
    return null;
  }
}

/** True when the decoder is usable at all. Checked once at startup so a broken
 *  decoder is reported loudly instead of silently degrading every pool to polling. */
export function decoderAvailable(): boolean {
  return ACCOUNT_NAME !== undefined;
}
