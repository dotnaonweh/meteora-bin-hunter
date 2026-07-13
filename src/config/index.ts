import { readFileSync } from 'node:fs';
import { fatal } from '../core/errors.js';
import type { LogLevel } from '../observability/logger.js';

export interface RpcEndpointConfig {
  readonly label: string;
  readonly url: string;
  /** Derived: wss:// form of `url`, used for account subscriptions. */
  readonly wsUrl: string;
}

export interface Config {
  readonly telegram: {
    readonly token: string;
    /** Chat IDs permitted to control the bot. NON-EMPTY by construction —
     *  an empty allowlist is a fatal config error, never an open bot. */
    readonly ownerChatIds: ReadonlySet<number>;
    readonly pollTimeoutSec: number;
  };
  readonly rpc: {
    readonly endpoints: readonly RpcEndpointConfig[];
    readonly commitment: 'processed' | 'confirmed' | 'finalized';
    readonly requestTimeoutMs: number;
    readonly maxRetries: number;
    /** How often to re-score endpoints and fail over if the active one degrades. */
    readonly healthCheckIntervalMs: number;
  };
  readonly tx: {
    /** Compute-unit price in micro-lamports. The original sent none, so its
     *  transactions competed for blockspace at zero priority. */
    readonly priorityFeeMicroLamports: number;
    readonly computeUnitLimit: number;
    /** Max active-bin drift tolerated between build and land, in bins. */
    readonly maxActiveBinSlippage: number;
    readonly confirmTimeoutMs: number;
    readonly maxSendAttempts: number;
  };
  readonly extreme: {
    /** Fallback poll interval when the websocket is down. */
    readonly pollIntervalMs: number;
    /** Floor between two state-machine evaluations. Defaults to the original
     *  2500ms so behaviour is unchanged out of the box; set to 0 to let the
     *  websocket drive rebalances at slot latency. */
    readonly minEvalIntervalMs: number;
    /** Circuit breaker: stop after this many cycles. 0 disables. */
    readonly maxCycles: number;
    /** Circuit breaker: stop if wallet SOL drops below this. */
    readonly minSolBalance: number;
    /** Settle delay after close before reopening, mirrors the original 3s. */
    readonly settleDelayMs: number;
    readonly tokenBalanceTimeoutMs: number;
  };
  readonly wallet: {
    /** SOL held back from `max`/percent sizing to cover fees and rent. */
    readonly feeReserveSol: number;
  };
  readonly state: {
    readonly dataFile: string;
    readonly envFile: string;
    /** Debounce window for coalescing state writes. */
    readonly flushIntervalMs: number;
  };
  readonly http: {
    readonly connections: number;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  readonly observability: {
    readonly logLevel: LogLevel;
    readonly logFormat: 'json' | 'pretty';
    readonly metricsIntervalMs: number;
  };
}

/** Minimal .env parser. Supports `#` comments, `export ` prefixes, and quoted
 *  values. Does not overwrite variables already present in the environment,
 *  so a real orchestrator (systemd, k8s) always wins over the file. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // absent .env is fine — the environment may be fully populated already
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key && env[key] === undefined) env[key] = value;
  }
}

// --- typed readers; every one has a default or is required explicitly ---

function str(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const v = env[key]?.trim();
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw fatal('config.missing', `Missing required environment variable ${key}`, { key });
  }
  return v;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min?: number, max?: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw fatal('config.invalid', `${key} must be a number, got "${raw}"`, { key });
  }
  if (min !== undefined && v < min) {
    throw fatal('config.invalid', `${key} must be >= ${min}, got ${v}`, { key });
  }
  if (max !== undefined && v > max) {
    throw fatal('config.invalid', `${key} must be <= ${max}, got ${v}`, { key });
  }
  return v;
}

function oneOf<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: T,
  fallback: T[number],
): T[number] {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw fatal('config.invalid', `${key} must be one of ${allowed.join('|')}, got "${raw}"`, { key });
  }
  return raw as T[number];
}

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

/**
 * RPC endpoints come from `RPC_ENDPOINTS` as a comma-separated list of
 * `label=url` pairs. `HELIUS_API_KEY` is interpolated into any `{HELIUS_API_KEY}`
 * placeholder, so the key never has to be committed inside a URL.
 */
function parseEndpoints(env: NodeJS.ProcessEnv): readonly RpcEndpointConfig[] {
  const heliusKey = env.HELIUS_API_KEY?.trim();
  const spec = env.RPC_ENDPOINTS?.trim();

  const raw: Array<{ label: string; url: string }> = [];

  if (spec) {
    for (const entry of spec.split(',')) {
      const part = entry.trim();
      if (!part) continue;
      const eq = part.indexOf('=');
      const label = eq > 0 ? part.slice(0, eq).trim() : 'rpc';
      const url = (eq > 0 ? part.slice(eq + 1) : part).trim();
      raw.push({ label, url });
    }
  } else {
    if (heliusKey) {
      raw.push({ label: 'helius', url: 'https://mainnet.helius-rpc.com/?api-key={HELIUS_API_KEY}' });
    }
    raw.push({ label: 'solana-public', url: 'https://api.mainnet-beta.solana.com' });
  }

  const endpoints = raw.map(({ label, url }) => {
    const resolved = url.replace('{HELIUS_API_KEY}', heliusKey ?? '');
    if (resolved.includes('{HELIUS_API_KEY}') || (url.includes('{HELIUS_API_KEY}') && !heliusKey)) {
      throw fatal('config.invalid', `RPC endpoint "${label}" needs HELIUS_API_KEY but it is not set`, { label });
    }
    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      throw fatal('config.invalid', `RPC endpoint "${label}" is not a valid URL`, { label });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw fatal('config.invalid', `RPC endpoint "${label}" must be http(s)`, { label });
    }
    return { label, url: resolved, wsUrl: toWsUrl(resolved) };
  });

  if (endpoints.length === 0) {
    throw fatal('config.invalid', 'No RPC endpoints configured. Set RPC_ENDPOINTS or HELIUS_API_KEY.');
  }
  return endpoints;
}

function parseOwners(env: NodeJS.ProcessEnv): ReadonlySet<number> {
  const raw = env.TELEGRAM_OWNER_IDS?.trim();
  if (!raw) {
    throw fatal(
      'config.missing',
      'TELEGRAM_OWNER_IDS is required. Without it the bot would accept commands — including ' +
        'wallet operations — from any Telegram user who finds it. Set it to your numeric chat ' +
        'ID (message @userinfobot to get it). Comma-separated for multiple owners.',
    );
  }
  const ids = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id)) {
      throw fatal('config.invalid', `TELEGRAM_OWNER_IDS contains a non-integer: "${trimmed}"`);
    }
    ids.add(id);
  }
  if (ids.size === 0) {
    throw fatal('config.invalid', 'TELEGRAM_OWNER_IDS was set but contained no valid ids');
  }
  return ids;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === 'production';

  return {
    telegram: {
      token: str(env, 'TELEGRAM_TOKEN'),
      ownerChatIds: parseOwners(env),
      pollTimeoutSec: num(env, 'TELEGRAM_POLL_TIMEOUT_SEC', 30, 1, 60),
    },
    rpc: {
      endpoints: parseEndpoints(env),
      commitment: oneOf(env, 'RPC_COMMITMENT', ['processed', 'confirmed', 'finalized'] as const, 'confirmed'),
      requestTimeoutMs: num(env, 'RPC_TIMEOUT_MS', 15_000, 1_000),
      maxRetries: num(env, 'RPC_MAX_RETRIES', 3, 0, 10),
      healthCheckIntervalMs: num(env, 'RPC_HEALTH_INTERVAL_MS', 60_000, 5_000),
    },
    tx: {
      priorityFeeMicroLamports: num(env, 'TX_PRIORITY_FEE_MICROLAMPORTS', 50_000, 0),
      computeUnitLimit: num(env, 'TX_COMPUTE_UNIT_LIMIT', 400_000, 1_000, 1_400_000),
      maxActiveBinSlippage: num(env, 'TX_MAX_ACTIVE_BIN_SLIPPAGE', 5, 0, 100),
      confirmTimeoutMs: num(env, 'TX_CONFIRM_TIMEOUT_MS', 45_000, 1_000),
      maxSendAttempts: num(env, 'TX_MAX_SEND_ATTEMPTS', 3, 1, 10),
    },
    extreme: {
      pollIntervalMs: num(env, 'EXTREME_POLL_INTERVAL_MS', 2_500, 250),
      minEvalIntervalMs: num(env, 'EXTREME_MIN_EVAL_INTERVAL_MS', 2_500, 0),
      maxCycles: num(env, 'EXTREME_MAX_CYCLES', 0, 0),
      minSolBalance: num(env, 'EXTREME_MIN_SOL_BALANCE', 0.01, 0),
      settleDelayMs: num(env, 'EXTREME_SETTLE_DELAY_MS', 3_000, 0),
      tokenBalanceTimeoutMs: num(env, 'EXTREME_TOKEN_BALANCE_TIMEOUT_MS', 10_000, 1_000),
    },
    wallet: {
      feeReserveSol: num(env, 'WALLET_FEE_RESERVE_SOL', 0.08, 0),
    },
    state: {
      dataFile: str(env, 'DATA_FILE', './data.json'),
      envFile: str(env, 'ENV_FILE', './.env'),
      flushIntervalMs: num(env, 'STATE_FLUSH_INTERVAL_MS', 250, 0),
    },
    http: {
      connections: num(env, 'HTTP_POOL_CONNECTIONS', 16, 1, 256),
      timeoutMs: num(env, 'HTTP_TIMEOUT_MS', 15_000, 1_000),
      maxRetries: num(env, 'HTTP_MAX_RETRIES', 3, 0, 10),
    },
    observability: {
      logLevel: oneOf(env, 'LOG_LEVEL', ['trace', 'debug', 'info', 'warn', 'error'] as const, 'info'),
      logFormat: oneOf(env, 'LOG_FORMAT', ['json', 'pretty'] as const, isProd ? 'json' : 'pretty'),
      metricsIntervalMs: num(env, 'METRICS_INTERVAL_MS', 60_000, 0),
    },
  };
}
