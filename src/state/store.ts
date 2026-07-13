import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { BASE58_SECRET_RE } from '../constants/index.js';
import { classify } from '../core/errors.js';
import type { PersistedState } from '../types/domain.js';
import { emptyState } from '../types/domain.js';
import type { Logger } from '../observability/logger.js';

/**
 * Durable JSON state with atomic writes and coalesced flushes.
 *
 * Two problems with the original:
 *   1. `writeFileSync` straight onto the live file — a crash mid-write leaves a
 *      truncated `data.json` and every tracked position is lost.
 *   2. `saveData()` ran a full `JSON.parse(JSON.stringify(state))` deep clone
 *      and a synchronous write on *every* mutation, blocking the event loop.
 *
 * Here writes go to a temp file and are `rename(2)`d into place (atomic on
 * POSIX), and mutations within `flushIntervalMs` are coalesced into one write.
 */
export class StateStore {
  private state: PersistedState;
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private readonly file: string,
    private readonly flushIntervalMs: number,
    private readonly log: Logger,
  ) {
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object') throw new Error('state root is not an object');
      // Merge onto a fresh skeleton so a file written by an older version (or a
      // partially hand-edited one) can never leave a required key undefined.
      return { ...emptyState(), ...(parsed as Partial<PersistedState>) };
    } catch (e) {
      const err = classify(e);
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn('could not read state file, starting fresh', { file: this.file, err: err.message });
      }
      return emptyState();
    }
  }

  /** Read-only view. Mutations must go through `update`. */
  get current(): Readonly<PersistedState> {
    return this.state;
  }

  /** Applies a mutation and schedules a flush. */
  update(fn: (state: PersistedState) => void): void {
    fn(this.state);
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    if (this.flushIntervalMs <= 0) {
      this.flushSync();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushSync();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  /**
   * Writes state to disk atomically.
   *
   * Also the last line of defence for secrets: a wallet *name* that looks like a
   * base58 secret key is scrubbed before it can be persisted. The original did
   * this via a full deep clone of the entire state on every save; here we only
   * allocate a replacement object when a name actually looks dangerous, which is
   * effectively never.
   */
  flushSync(): void {
    if (!this.dirty) return;

    const safeWallets: PersistedState['wallets'] = {};
    let scrubbed = false;
    for (const [id, w] of Object.entries(this.state.wallets)) {
      if (BASE58_SECRET_RE.test(w.name)) {
        safeWallets[id] = { ...w, name: 'Wallet' };
        scrubbed = true;
      } else {
        safeWallets[id] = w;
      }
    }
    if (scrubbed) {
      this.log.warn('scrubbed a wallet name that looked like a secret key before persisting');
      this.state.wallets = safeWallets;
    }

    const dir = dirname(this.file);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.file); // atomic
      this.dirty = false;
    } catch (e) {
      this.log.error('failed to persist state', { file: this.file, err: classify(e).message });
    }
  }

  /** Flush and stop the timer. Called on shutdown so nothing is lost. */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushSync();
  }
}
