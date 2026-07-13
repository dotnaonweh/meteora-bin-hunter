import DLMM from '@meteora-ag/dlmm';
import type { LbPosition, StrategyParameters } from '@meteora-ag/dlmm';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import type { Config } from '../../config/index.js';
import {
  FULL_BPS,
  MAX_BINS_EXTENDED,
  MAX_BINS_PER_POSITION,
  SOL_MINT,
  type StrategyTypeValue,
} from '../../constants/index.js';
import { AppError, classify, recoverable } from '../../core/errors.js';
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

  /**
   * Opens a new position and seeds it with SOL on the quote side.
   *
   * Two paths, chosen by width:
   *  - <= 70 bins: a classic position, created and funded in one transaction.
   *  - >  70 bins: a resizable *extended* position (up to 1400 bins), which is
   *    what the official Meteora app uses for wide ranges. It cannot fit in one
   *    transaction, so the SDK hands back instruction groups to land in sequence.
   */
  async openPosition(params: OpenPositionParams): Promise<OpenPositionResult> {
    const pool = await this.pools.getFresh(params.poolAddress, true);
    const activeBinId = pool.lbPair.activeId;
    const binCount = params.maxBinId - params.minBinId + 1;

    const strategy = {
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
      strategyType: params.strategy,
    };
    const totalYAmount = new BN(solToLamports(params.solAmount).toString());

    const { positionKey, signature } =
      binCount <= MAX_BINS_PER_POSITION
        ? await this.openClassicPosition(pool, params, strategy, totalYAmount)
        : await this.openExtendedPosition(pool, params, strategy, totalYAmount, binCount);

    this.pools.invalidate(params.poolAddress);
    this.metrics.increment('dlmm.positionsOpened');
    this.metrics.observe('dlmm.positionBins', binCount);

    return {
      positionKey,
      signature,
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
      activeBinId,
    };
  }

  private async openClassicPosition(
    pool: DLMM,
    params: OpenPositionParams,
    strategy: StrategyParameters,
    totalYAmount: BN,
  ): Promise<{ positionKey: string; signature: string }> {
    const positionKeypair = Keypair.generate();

    const tx = await this.rpc.execute('initializePositionAndAddLiquidityByStrategy', () =>
      pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: params.owner.publicKey,
        totalXAmount: new BN(0),
        totalYAmount,
        strategy,
        // v1 passed no slippage at all, so a bin move between build and land was
        // silently accepted at whatever price resulted.
        slippage: this.cfg.tx.maxActiveBinSlippage,
      }),
    );

    const signature = await this.tx.send(asTransaction(tx), {
      signers: [params.owner, positionKeypair],
      signal: params.signal,
      label: 'openPosition',
    });

    return { positionKey: positionKeypair.publicKey.toBase58(), signature };
  }

  /**
   * Wide range: an extended position, landed across several transactions.
   *
   * The SDK returns `transactionInstructions` as a list of groups. Every group
   * begins with its own compute-budget instruction and then repeats the SAME
   * init + extend instruction objects, with only a chunk-specific tail differing.
   * Landing that shared prefix more than once fails on-chain with "account
   * already in use", so it is stripped from every group after the first —
   * identified by reference equality, which is exactly how the SDK reuses them.
   */
  private async openExtendedPosition(
    pool: DLMM,
    params: OpenPositionParams,
    strategy: StrategyParameters,
    totalYAmount: BN,
    binCount: number,
  ): Promise<{ positionKey: string; signature: string }> {
    if (binCount > MAX_BINS_EXTENDED) {
      throw recoverable(
        'position.tooWide',
        `That range needs ${binCount} bins, but a position tops out at ${MAX_BINS_EXTENDED}. ` +
          `Use a narrower range, or a pool with a larger bin step.`,
      );
    }

    const { instructionsByPositions } = await this.rpc.execute(
      'initializeMultiplePositionAndAddLiquidityByStrategy2',
      () =>
        pool.initializeMultiplePositionAndAddLiquidityByStrategy2(
          (count: number) => Promise.resolve(Array.from({ length: count }, () => Keypair.generate())),
          new BN(0),
          totalYAmount,
          strategy,
          params.owner.publicKey,
          params.owner.publicKey,
          this.cfg.tx.maxActiveBinSlippage,
        ),
    );

    // More than one position means the range spilled past a single extended
    // position. Splitting a deposit across several positions changes what the
    // user is tracking and how it is closed, so refuse rather than half-do it.
    if (instructionsByPositions.length !== 1) {
      throw recoverable(
        'position.multiRequired',
        `That range (${binCount} bins) needs ${instructionsByPositions.length} separate positions, ` +
          `which this bot does not manage yet. Use a narrower range.`,
      );
    }

    const entry = instructionsByPositions[0];
    if (!entry) throw recoverable('position.noInstructions', 'The SDK returned no instructions for this position.');

    const { positionKeypair, transactionInstructions } = entry;
    const groups = stripSharedPrefix(transactionInstructions);

    this.log.info('opening extended position', {
      bins: binCount,
      transactions: groups.length,
      position: positionKeypair.publicKey.toBase58(),
    });

    // Sequential, not parallel: the first transaction creates the position
    // account that every later one depends on.
    const positionKey = positionKeypair.publicKey.toBase58();
    let signature = '';

    for (let i = 0; i < groups.length; i++) {
      const ixs = groups[i];
      if (!ixs || ixs.length === 0) continue;

      const tx = new Transaction({ feePayer: params.owner.publicKey }).add(...ixs);

      try {
        signature = await this.tx.send(tx, {
          // Only the first transaction creates the position account, so only it
          // needs the position keypair's signature.
          signers: i === 0 ? [params.owner, positionKeypair] : [params.owner],
          signal: params.signal,
          label: `openExtended[${i + 1}/${groups.length}]`,
        });
      } catch (e) {
        // A wide range can be 18+ transactions. If one fails partway, the
        // position ALREADY EXISTS on-chain and already holds funds — so the
        // failure must carry the position key upward, or the caller would throw
        // it away and the bot would lose track of real money.
        if (i === 0) throw e; // nothing was created; a clean failure

        this.metrics.increment('dlmm.extendedPartial');
        this.log.error('extended position partially funded', {
          position: positionKey,
          landed: i,
          total: groups.length,
        });

        throw new AppError(
          'position.partiallyFunded',
          `Position was created but only ${i} of ${groups.length} deposit transactions landed. ` +
            `It exists on-chain and holds funds — it has been saved so you can remove it from Positions. ` +
            `Cause: ${classify(e).message}`,
          'recoverable',
          { positionKey, minBinId: params.minBinId, maxBinId: params.maxBinId, landed: i, total: groups.length },
          { cause: e },
        );
      }
      this.metrics.increment('dlmm.extendedChunks');
    }

    return { positionKey, signature };
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

/**
 * Removes the init+extend instructions that the SDK repeats across every
 * transaction group of an extended position.
 *
 * A real group, dumped from the SDK against a mainnet pool:
 *
 *   tx1: [ ComputeBudget, initialize_position2, increase_position_length2,
 *          initialize_bin_array x2, createATA(idempotent) x2, ..., rebalance_liquidity ]
 *   tx2: [ ComputeBudget, initialize_position2*, increase_position_length2*,
 *          initialize_bin_array, createATA(idempotent) x2*, ..., rebalance_liquidity ]
 *                          (* = the SAME object reference as in tx1)
 *
 * `initialize_position2` and `increase_position_length2` are the two that MUST
 * land exactly once — sending them twice fails with "account already in use".
 * They form a contiguous run right after the compute-budget instruction, so they
 * are stripped from every group after the first, matched by reference equality
 * rather than an assumed length.
 *
 * The other repeats are deliberately left alone, because both are verified
 * idempotent against mainnet:
 *   - `initialize_bin_array` is `init_if_needed` — simulating it against an
 *     already-initialised bin array returns success, not an error.
 *   - the ATA instructions are the idempotent variant (`data = [1]`).
 * That is also why the SDK is happy to emit them in more than one transaction.
 */
function stripSharedPrefix(groups: readonly TransactionInstruction[][]): TransactionInstruction[][] {
  const first = groups[0];
  if (!first || groups.length <= 1) return groups.map((g) => [...g]);

  // Start by assuming everything after the compute-budget ix is shared, then
  // shrink to the longest prefix common to every group.
  let sharedLen = first.length - 1;
  for (let g = 1; g < groups.length; g++) {
    const group = groups[g];
    if (!group) continue;
    let i = 1;
    while (i <= sharedLen && i < group.length && group[i] === first[i]) i++;
    sharedLen = i - 1;
  }

  return groups.map((group, index) =>
    index === 0 ? [...group] : [group[0]!, ...group.slice(1 + sharedLen)],
  );
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
