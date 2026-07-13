import DLMM from '@meteora-ag/dlmm';
import type { LbPosition } from '@meteora-ag/dlmm';
import { Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import type { Config } from '../../config/index.js';
import { FULL_BPS, SOL_MINT, type StrategyTypeValue } from '../../constants/index.js';
import { recoverable } from '../../core/errors.js';
import { sleep } from '../../net/retry.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from '../../providers/rpc/endpoint-pool.js';
import { solToLamports } from '../../utils/format.js';
import { PoolCache } from './pool-cache.js';
import { TxSender } from './tx.js';

export interface OpenPositionParams {
  readonly poolAddress: string;
  readonly owner: Keypair;
  readonly solAmount: number;
  readonly minBinId: number;
  readonly maxBinId: number;
  readonly strategy: StrategyTypeValue;
  readonly signal?: AbortSignal;
}

export interface OpenPositionResult {
  readonly positionKey: string;
  readonly signature: string;
  readonly minBinId: number;
  readonly maxBinId: number;
  readonly activeBinId: number;
}

export interface PoolTokens {
  readonly tokenXMint: string;
  readonly tokenYMint: string;
  /** True when the non-SOL side of the pool is token X. */
  readonly baseIsX: boolean;
  readonly baseMint: string;
}

/**
 * All DLMM position operations, expressed once.
 *
 * The original repeated the same "build removeLiquidity -> normalise to array ->
 * Promise.all(sendAndConfirm)" block in four functions, and the same
 * "create pool -> refetch -> getPositionsByUserAndLbPair -> find by key" lookup
 * in three. Both now exist exactly once.
 */
export class DlmmClient {
  private readonly log: Logger;

  constructor(
    private readonly pools: PoolCache,
    private readonly tx: TxSender,
    private readonly rpc: RpcPool,
    private readonly cfg: Config,
    logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.log = logger.child({ module: 'dlmm' });
  }

  async getPool(address: string): Promise<DLMM> {
    return this.pools.get(address);
  }

  /** Active bin id. Served from cached state unless a refresh is warranted. */
  async activeBinId(poolAddress: string): Promise<number> {
    const pool = await this.pools.getFresh(poolAddress);
    return pool.lbPair.activeId;
  }

  async binStep(poolAddress: string): Promise<number> {
    const pool = await this.pools.get(poolAddress);
    return pool.lbPair.binStep;
  }

  tokensOf(pool: DLMM): PoolTokens {
    const tokenXMint = pool.lbPair.tokenXMint.toBase58();
    const tokenYMint = pool.lbPair.tokenYMint.toBase58();
    const baseIsX = tokenXMint !== SOL_MINT;
    return {
      tokenXMint,
      tokenYMint,
      baseIsX,
      baseMint: baseIsX ? tokenXMint : tokenYMint,
    };
  }

  /** Single source of truth for "find this user's position in this pool". */
  async findPosition(poolAddress: string, owner: PublicKey, positionKey: string): Promise<LbPosition | null> {
    const pool = await this.pools.getFresh(poolAddress);
    const { userPositions } = await this.metrics.time('dlmm.getPositions', () =>
      this.rpc.execute('getPositionsByUserAndLbPair', () => pool.getPositionsByUserAndLbPair(owner)),
    );
    return userPositions.find((p) => p.publicKey.toBase58() === positionKey) ?? null;
  }

  /** Opens a new position and seeds it with SOL on the quote side. */
  async openPosition(params: OpenPositionParams): Promise<OpenPositionResult> {
    const pool = await this.pools.getFresh(params.poolAddress, true);
    const activeBinId = pool.lbPair.activeId;
    const positionKeypair = Keypair.generate();

    const tx = await this.rpc.execute('initializePositionAndAddLiquidityByStrategy', () =>
      pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: params.owner.publicKey,
        totalXAmount: new BN(0),
        totalYAmount: new BN(solToLamports(params.solAmount).toString()),
        strategy: {
          minBinId: params.minBinId,
          maxBinId: params.maxBinId,
          strategyType: params.strategy,
        },
        // The original passed no slippage at all, so a bin move between build
        // and land would be silently accepted at whatever price resulted.
        slippage: this.cfg.tx.maxActiveBinSlippage,
      }),
    );

    const signature = await this.tx.send(asTransaction(tx), {
      signers: [params.owner, positionKeypair],
      signal: params.signal,
      label: 'openPosition',
    });

    this.pools.invalidate(params.poolAddress);
    this.metrics.increment('dlmm.positionsOpened');

    return {
      positionKey: positionKeypair.publicKey.toBase58(),
      signature,
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
      activeBinId,
    };
  }

  /**
   * Removes all liquidity from a position.
   * `close: true` also claims fees and closes the position account (reclaiming rent).
   */
  async removeAllLiquidity(args: {
    poolAddress: string;
    owner: Keypair;
    positionKey: string;
    close: boolean;
    signal?: AbortSignal;
  }): Promise<string[]> {
    const position = await this.findPosition(args.poolAddress, args.owner.publicKey, args.positionKey);
    if (!position) {
      throw recoverable('position.notFound', 'Position not found on-chain.');
    }

    const pool = await this.pools.getFresh(args.poolAddress);
    const bins = position.positionData.positionBinData;

    if (bins.length === 0) {
      if (!args.close) return [];
      // Nothing to withdraw, but the account still holds rent. Close it.
      const closeTx = await this.rpc.execute('closePosition', () =>
        pool.closePosition({ owner: args.owner.publicKey, position }),
      );
      const sig = await this.tx.send(asTransaction(closeTx), {
        signers: [args.owner],
        skipPreflight: true,
        signal: args.signal,
        label: 'closePosition',
      });
      this.pools.invalidate(args.poolAddress);
      return [sig];
    }

    const removeTx = await this.rpc.execute('removeLiquidity', () =>
      pool.removeLiquidity({
        position: new PublicKey(args.positionKey),
        user: args.owner.publicKey,
        fromBinId: bins[0]!.binId,
        toBinId: bins[bins.length - 1]!.binId,
        bps: new BN(FULL_BPS),
        shouldClaimAndClose: args.close,
      }),
    );

    const signatures = await this.tx.sendAll(asTransactions(removeTx), {
      signers: [args.owner],
      skipPreflight: true, // speed matters here; the tx shape is SDK-generated
      signal: args.signal,
      label: args.close ? 'removeAndClose' : 'remove',
    });

    this.pools.invalidate(args.poolAddress);
    this.metrics.increment(args.close ? 'dlmm.positionsClosed' : 'dlmm.liquidityRemoved');
    return signatures;
  }

  /** Adds an existing token balance back into a single bin. */
  async addLiquidityToBin(args: {
    poolAddress: string;
    owner: Keypair;
    positionKey: string;
    binId: number;
    amount: BN;
    baseIsX: boolean;
    strategy: StrategyTypeValue;
    signal?: AbortSignal;
  }): Promise<string> {
    const pool = await this.pools.getFresh(args.poolAddress, true);

    const tx = await this.rpc.execute('addLiquidityByStrategy', () =>
      pool.addLiquidityByStrategy({
        positionPubKey: new PublicKey(args.positionKey),
        user: args.owner.publicKey,
        totalXAmount: args.baseIsX ? args.amount : new BN(0),
        totalYAmount: args.baseIsX ? new BN(0) : args.amount,
        strategy: {
          minBinId: args.binId,
          maxBinId: args.binId,
          strategyType: args.strategy,
        },
        slippage: this.cfg.tx.maxActiveBinSlippage,
      }),
    );

    const signature = await this.tx.send(asTransaction(tx), {
      signers: [args.owner],
      skipPreflight: true,
      signal: args.signal,
      label: 'addLiquidity',
    });
    this.pools.invalidate(args.poolAddress);
    return signature;
  }

  /**
   * Polls for a non-zero SPL balance of `mint`, which appears only once the
   * withdrawal has settled. Same 500ms cadence and deadline semantics as the
   * original, but abortable and with the deadline sourced from config.
   */
  async waitForTokenBalance(owner: PublicKey, mint: string, signal?: AbortSignal): Promise<BN> {
    const deadline = Date.now() + this.cfg.extreme.tokenBalanceTimeoutMs;
    const mintKey = new PublicKey(mint);

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const accounts = await this.rpc.execute(
          'getParsedTokenAccountsByOwner',
          (conn) => conn.getParsedTokenAccountsByOwner(owner, { mint: mintKey }, 'processed'),
          signal,
        );
        const raw = accounts.value[0]?.account.data.parsed?.info?.tokenAmount?.amount;
        if (typeof raw === 'string') {
          const balance = new BN(raw);
          if (!balance.isZero()) return balance;
        }
      } catch (e) {
        // Transient RPC failure while settling; keep polling until the deadline.
        this.log.debug('token balance poll failed', { err: e instanceof Error ? e.message : String(e) });
      }
      await sleep(500, signal);
    }
    return new BN(0);
  }

  async solBalance(pubkey: PublicKey, signal?: AbortSignal): Promise<number> {
    const lamports = await this.rpc.execute('getBalance', (conn) => conn.getBalance(pubkey), signal);
    return lamports / 1e9;
  }

  /** All of a user's positions across every pool, keyed by position pubkey. */
  async allPositions(owner: PublicKey, signal?: AbortSignal): Promise<Map<string, { poolAddress: string; position: LbPosition }>> {
    const all = await this.metrics.time('dlmm.getAllPositions', () =>
      this.rpc.execute('getAllLbPairPositionsByUser', (conn) => DLMM.getAllLbPairPositionsByUser(conn, owner), signal),
    );

    const out = new Map<string, { poolAddress: string; position: LbPosition }>();
    for (const [poolAddress, poolData] of all) {
      for (const position of poolData.lbPairPositionsData) {
        out.set(position.publicKey.toBase58(), { poolAddress, position });
      }
    }
    return out;
  }
}

/** The SDK returns `Transaction | Transaction[]` depending on how many bin
 *  arrays a call touches. Normalise once, here, instead of at four call sites. */
function asTransactions(tx: Transaction | Transaction[]): Transaction[] {
  return Array.isArray(tx) ? tx : [tx];
}

function asTransaction(tx: Transaction | Transaction[]): Transaction {
  if (Array.isArray(tx)) {
    if (tx.length !== 1) {
      throw recoverable('tx.unexpectedBatch', `Expected a single transaction, got ${tx.length}`);
    }
    return tx[0]!;
  }
  return tx;
}
