import DLMM from '@meteora-ag/dlmm';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { LAMPORTS_PER_SOL } from '../../constants/index.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from '../../providers/rpc/endpoint-pool.js';

const { BIN_ARRAY_FEE, TOKEN_ACCOUNT_FEE, getPositionRentExemption, getBinArrayIndexesCoverage, deriveBinArray } =
  DLMM as unknown as {
    BIN_ARRAY_FEE: number;
    TOKEN_ACCOUNT_FEE: number;
    getPositionRentExemption: (conn: unknown, binCount: BN) => Promise<number | bigint>;
    getBinArrayIndexesCoverage: (min: BN, max: BN) => BN[];
    deriveBinArray: (lbPair: PublicKey, index: BN, programId: PublicKey) => [PublicKey, number];
  };

/** Base + priority fee headroom, plus a small safety margin. */
const TX_FEE_BUFFER_SOL = 0.002;

/**
 * How much SOL to hold back from a `max` / `N%` deposit.
 *
 * A flat reserve (v1 used 0.08 SOL unconditionally) is fine for a narrow
 * position but badly wrong for a wide one: position rent scales with bin count,
 * and a wide range can require brand-new bin arrays at ~0.071 SOL *each*. A
 * 1400-bin position can need well over 1 SOL of rent — so `max` would size the
 * deposit to consume the entire balance and the transaction would simply fail
 * for want of rent.
 *
 * This prices the *actual* range being opened: position rent for this bin count,
 * plus rent for only the bin arrays and ATAs that do not already exist on-chain.
 */
export async function estimateLpReserveSol(
  rpc: RpcPool,
  metrics: Metrics,
  pool: DLMM,
  minBinId: number,
  maxBinId: number,
  owner: PublicKey,
  signal?: AbortSignal,
): Promise<number> {
  const binCount = maxBinId - minBinId + 1;

  const binArrayPdas = getBinArrayIndexesCoverage(new BN(minBinId), new BN(maxBinId)).map(
    (index) => deriveBinArray(pool.pubkey, index, pool.program.programId)[0],
  );

  const ataPdas = [
    getAssociatedTokenAddressSync(pool.tokenX.publicKey, owner, true, pool.tokenX.owner),
    getAssociatedTokenAddressSync(pool.tokenY.publicKey, owner, true, pool.tokenY.owner),
  ];

  // Three independent reads — issue them together rather than in sequence.
  const [positionRentLamports, binArrayInfos, ataInfos] = await Promise.all([
    rpc.execute('getPositionRentExemption', (conn) => getPositionRentExemption(conn, new BN(binCount)), signal),
    rpc.execute('getMultipleAccountsInfo', (conn) => conn.getMultipleAccountsInfo(binArrayPdas), signal),
    rpc.execute('getMultipleAccountsInfo', (conn) => conn.getMultipleAccountsInfo(ataPdas), signal),
  ]);

  // Only accounts that do not exist yet cost us rent.
  const missingBinArrays = binArrayInfos.filter((info) => info === null).length;
  const missingAtas = ataInfos.filter((info) => info === null).length;

  const totalSol =
    Number(positionRentLamports) / LAMPORTS_PER_SOL +
    missingBinArrays * BIN_ARRAY_FEE +
    missingAtas * TOKEN_ACCOUNT_FEE +
    TX_FEE_BUFFER_SOL;

  metrics.observe('dlmm.reserveSol', totalSol);
  return totalSol;
}
