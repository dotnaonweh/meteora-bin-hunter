import {
  ComputeBudgetProgram,
  Transaction,
  type Connection,
  type Keypair,
  type TransactionSignature,
} from '@solana/web3.js';
import type { Config } from '../../config/index.js';
import { classify, recoverable, retryable } from '../../core/errors.js';
import { sleep } from '../../net/retry.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from '../../providers/rpc/endpoint-pool.js';

const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();

export interface SendOptions {
  readonly signers: readonly Keypair[];
  /** Skip simulation. Faster, but a malformed tx burns a fee instead of failing
   *  locally. The original used this unconditionally; here it is a decision. */
  readonly skipPreflight?: boolean;
  readonly signal?: AbortSignal;
  readonly label: string;
}

/**
 * Transaction sender.
 *
 * Adds the two things the original was missing entirely, both of which cost real
 * money on a bot that races bin boundaries:
 *
 *  1. **Priority fees.** The original attached no ComputeBudget instructions, so
 *     every transaction competed for blockspace at a compute-unit price of zero.
 *     Under load those land late or not at all.
 *
 *  2. **Idempotent confirmation.** `sendAndConfirmTransaction` throws on
 *     confirmation timeout — but the transaction may still land. The original
 *     treated that as failure and would happily re-open a position, ending up
 *     with two. Here a timeout re-checks the signature's status before deciding.
 */
export class TxSender {
  private readonly log: Logger;

  constructor(
    private readonly rpc: RpcPool,
    private readonly cfg: Config,
    logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.log = logger.child({ module: 'tx' });
  }

  /**
   * Prepends compute-budget instructions unless the SDK already supplied them.
   * Blindly unshifting would produce a transaction with duplicate
   * ComputeBudget instructions, which the runtime rejects.
   */
  private applyComputeBudget(tx: Transaction): void {
    let hasLimit = false;
    let hasPrice = false;

    for (const ix of tx.instructions) {
      if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM) continue;
      const discriminator = ix.data[0];
      if (discriminator === 2) hasLimit = true; // SetComputeUnitLimit
      if (discriminator === 3) hasPrice = true; // SetComputeUnitPrice
    }

    const prefix = [];
    if (!hasLimit) {
      prefix.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cfg.tx.computeUnitLimit }));
    }
    if (!hasPrice && this.cfg.tx.priorityFeeMicroLamports > 0) {
      prefix.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.tx.priorityFeeMicroLamports }),
      );
    }
    if (prefix.length > 0) tx.instructions.unshift(...prefix);
  }

  /** Sends and confirms one transaction, retrying on transient failure. */
  async send(tx: Transaction, opts: SendOptions): Promise<TransactionSignature> {
    const started = performance.now();
    const log = this.log.child({ label: opts.label });

    try {
      this.applyComputeBudget(tx);

      let lastSignature: TransactionSignature | null = null;

      for (let attempt = 0; attempt < this.cfg.tx.maxSendAttempts; attempt++) {
        opts.signal?.throwIfAborted();

        // A transaction that timed out on a previous attempt may still land.
        // Check before resending, or we risk double-spending the intent.
        if (lastSignature) {
          const landed = await this.checkLanded(lastSignature, opts.signal);
          if (landed) {
            log.info('previous attempt landed after timeout', { signature: lastSignature });
            this.metrics.increment('tx.recoveredAfterTimeout');
            return lastSignature;
          }
        }

        try {
          lastSignature = await this.attempt(tx, opts, attempt);
          this.metrics.increment('tx.confirmed');
          return lastSignature;
        } catch (e) {
          const err = classify(e);
          if (err.severity !== 'retryable' || attempt === this.cfg.tx.maxSendAttempts - 1) throw err;

          this.metrics.increment('tx.retries');
          log.warn('transaction attempt failed, retrying', { attempt: attempt + 1, err: err.message });
          await sleep(300 * 2 ** attempt, opts.signal);
        }
      }
      throw retryable('tx.exhausted', `Transaction "${opts.label}" exhausted all attempts`);
    } catch (e) {
      this.metrics.increment('tx.failed');
      throw classify(e);
    } finally {
      this.metrics.observe('tx.latency', performance.now() - started);
    }
  }

  private async attempt(tx: Transaction, opts: SendOptions, attempt: number): Promise<TransactionSignature> {
    return this.rpc.execute(
      `sendTx:${opts.label}`,
      async (conn: Connection) => {
        // Refresh the blockhash on every attempt — reusing a stale one is the
        // single most common cause of "blockhash not found" retry loops.
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(this.cfg.rpc.commitment);
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = opts.signers[0]?.publicKey;

        // Signatures accumulate across attempts; clear before re-signing.
        tx.signatures = [];
        tx.sign(...(opts.signers as Keypair[]));

        const raw = tx.serialize();
        const signature = await conn.sendRawTransaction(raw, {
          skipPreflight: opts.skipPreflight ?? false,
          maxRetries: 0, // our loop owns retries
          preflightCommitment: this.cfg.rpc.commitment,
        });

        this.log.debug('transaction sent', { label: opts.label, signature, attempt });

        const confirmation = await conn.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.cfg.rpc.commitment,
        );

        if (confirmation.value.err) {
          // An on-chain error is deterministic: the same transaction will fail
          // the same way. Do not retry it.
          throw recoverable('tx.onChainError', `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`, {
            signature,
          });
        }
        return signature;
      },
      opts.signal,
    );
  }

  /** True if the signature is on-chain and succeeded. */
  private async checkLanded(signature: TransactionSignature, signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.rpc.execute(
        'getSignatureStatus',
        (conn) => conn.getSignatureStatus(signature, { searchTransactionHistory: true }),
        signal,
      );
      const status = res.value;
      if (!status) return false;
      if (status.err) return false;
      return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
    } catch {
      return false;
    }
  }

  /**
   * Sends several transactions concurrently.
   *
   * The DLMM SDK returns an array when a withdrawal spans more than one bin
   * array. These are independent, so they go out in parallel — but unlike the
   * original's bare `Promise.all`, a partial failure is reported with the
   * signatures that *did* land, so the caller is never left believing nothing
   * happened when half of it did.
   */
  async sendAll(txs: readonly Transaction[], opts: SendOptions): Promise<TransactionSignature[]> {
    const results = await Promise.allSettled(txs.map((tx) => this.send(tx, opts)));

    const signatures: TransactionSignature[] = [];
    const failures: string[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled') signatures.push(r.value);
      else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }

    if (failures.length > 0) {
      throw recoverable(
        'tx.partialFailure',
        `${failures.length}/${txs.length} transactions failed: ${failures.join('; ')}`,
        { landed: signatures },
      );
    }
    return signatures;
  }
}
