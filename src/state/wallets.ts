import { Keypair } from '@solana/web3.js';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import bs58 from 'bs58';
import { BASE58_SECRET_RE } from '../constants/index.js';
import { recoverable } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import type { WalletMeta } from '../types/domain.js';
import type { StateStore } from './store.js';

/**
 * Wallet registry.
 *
 * Secrets live only in the environment (and the `.env` file backing it); the
 * state file holds nothing but the pubkey and the env var *name*.
 *
 * The important performance change: `Keypair.fromSecretKey(bs58.decode(...))` is
 * done **once per wallet** and cached. The original re-derived the keypair on
 * every single call to `getActiveWallet()` — which the extreme-mode hot path
 * calls several times per cycle. Ed25519 key expansion is not free.
 */
export class WalletRegistry {
  private readonly keypairs = new Map<string, Keypair>();

  constructor(
    private readonly store: StateStore,
    private readonly envFile: string,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Every WALLET_n key currently in the environment, in numeric order.
   *
   * Deliberately NOT a `for (i=1; env[WALLET_i]; i++)` loop: that stops at the
   * first gap, so deleting WALLET_2 while WALLET_3 exists would make WALLET_3
   * invisible — and, when `.env` is rewritten, silently erase it.
   */
  private walletEnvKeys(): string[] {
    return Object.keys(this.env)
      .filter((k) => /^WALLET_\d+$/.test(k) && this.env[k])
      .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  }

  /** Imports any WALLET_n present in the environment that we do not track yet. */
  bootstrapFromEnv(): void {
    for (const envKey of this.walletEnvKeys()) {
      const secret = this.env[envKey];
      if (!secret) continue;

      const tracked = Object.values(this.store.current.wallets).some((w) => w.envKey === envKey);
      if (tracked) continue;

      try {
        const kp = this.decode(secret);
        const pubkey = kp.publicKey.toBase58();
        const id = pubkey.slice(0, 8);
        this.store.update((s) => {
          s.wallets[id] = { id, name: `Wallet ${envKey.slice(7)}`, pubkey, envKey };
          s.activeWalletId ??= id;
        });
        this.keypairs.set(id, kp);
        this.log.info('loaded wallet from env', { envKey, pubkey });
      } catch {
        // Never log the value — only that the slot is bad.
        this.log.error('could not decode wallet secret', { envKey });
      }
    }
  }

  private decode(secret: string): Keypair {
    const trimmed = secret.trim();
    if (!BASE58_SECRET_RE.test(trimmed)) {
      throw recoverable('wallet.badSecret', 'Private key must be base58-encoded (64-88 characters)');
    }
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw recoverable('wallet.badSecret', 'Private key is not valid base58');
    }
    if (bytes.length !== 64) {
      throw recoverable('wallet.badSecret', `Private key must decode to 64 bytes, got ${bytes.length}`);
    }
    return Keypair.fromSecretKey(bytes);
  }

  get activeMeta(): WalletMeta | null {
    const { activeWalletId, wallets } = this.store.current;
    if (!activeWalletId) return null;
    return wallets[activeWalletId] ?? null;
  }

  /** The active signer, or null if no wallet is configured. Cached. */
  active(): Keypair | null {
    const meta = this.activeMeta;
    if (!meta) return null;

    const cached = this.keypairs.get(meta.id);
    if (cached) return cached;

    const secret = this.env[meta.envKey];
    if (!secret) {
      throw recoverable('wallet.missingSecret', `Secret for wallet "${meta.name}" not found: set ${meta.envKey} in .env`);
    }
    const kp = this.decode(secret);
    this.keypairs.set(meta.id, kp);
    return kp;
  }

  /** Throwing variant for paths that cannot proceed without a signer. */
  requireActive(): Keypair {
    const kp = this.active();
    if (!kp) throw recoverable('wallet.none', 'No active wallet. Import one first.');
    return kp;
  }

  list(): readonly WalletMeta[] {
    return Object.values(this.store.current.wallets);
  }

  add(name: string, secret: string): WalletMeta {
    const kp = this.decode(secret); // validates before anything is persisted
    const pubkey = kp.publicKey.toBase58();
    const id = pubkey.slice(0, 8);

    const existing = this.store.current.wallets[id];
    if (existing) {
      this.keypairs.set(id, kp);
      return existing;
    }

    const envKey = this.nextEnvKey();
    this.env[envKey] = secret.trim();
    this.writeEnvFile();

    const meta: WalletMeta = { id, name, pubkey, envKey };
    this.store.update((s) => {
      s.wallets[id] = meta;
      s.activeWalletId ??= id;
    });
    this.keypairs.set(id, kp);
    return meta;
  }

  switch(id: string): WalletMeta {
    const meta = this.store.current.wallets[id];
    if (!meta) throw recoverable('wallet.notFound', 'Wallet not found');
    this.store.update((s) => {
      s.activeWalletId = id;
    });
    return meta;
  }

  remove(id: string): void {
    const meta = this.store.current.wallets[id];
    if (!meta) throw recoverable('wallet.notFound', 'Wallet not found');

    delete this.env[meta.envKey];
    this.keypairs.delete(id);

    this.store.update((s) => {
      delete s.wallets[id];
      if (s.activeWalletId === id) {
        s.activeWalletId = Object.keys(s.wallets)[0] ?? null;
      }
    });
    this.writeEnvFile();
  }

  private nextEnvKey(): string {
    for (let i = 1; ; i++) {
      if (!this.env[`WALLET_${i}`]) return `WALLET_${i}`;
    }
  }

  /**
   * Rewrites `.env`, preserving every non-WALLET line (including comments and
   * blank lines — the original's `filter(Boolean)` silently deleted them) and
   * re-emitting the WALLET_n entries from the live environment.
   *
   * Written atomically with mode 0600 so a crash cannot leave a half-written
   * file containing keys, and so the keys are never briefly world-readable.
   */
  private writeEnvFile(): void {
    let existing = '';
    try {
      existing = readFileSync(this.envFile, 'utf8');
    } catch {
      /* first write */
    }

    const preserved = existing
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return true; // keep comments/blanks
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return true;
        return !/^WALLET_\d+$/.test(trimmed.slice(0, eq).trim());
      });

    while (preserved.length > 0 && preserved[preserved.length - 1]!.trim() === '') preserved.pop();

    const walletLines = this.walletEnvKeys().map((key) => `${key}=${this.env[key]}`);

    const contents = [...preserved, ...walletLines].join('\n') + '\n';
    const tmp = `${this.envFile}.${process.pid}.tmp`;
    writeFileSync(tmp, contents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.envFile);
  }
}
