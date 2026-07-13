import { isAppError } from '../core/errors.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Child logger carrying additional bound fields (e.g. module, poolAddress). */
  child(bindings: LogFields): Logger;
  /** Times an async operation and logs its duration. Errors are logged and rethrown. */
  timed<T>(msg: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** `json` for production (one object per line, ingestible), `pretty` for dev. */
  readonly format: 'json' | 'pretty';
  readonly out?: (line: string) => void;
}

const COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

/** Secrets must never reach a log sink, regardless of what a caller passes. */
const REDACT_KEYS = /^(pk|secret|secretKey|privateKey|token|telegramToken|apiKey|env)$/i;

function serializeError(e: unknown): LogFields {
  if (isAppError(e)) {
    return { err: e.message, code: e.code, severity: e.severity, ...e.context };
  }
  if (e instanceof Error) {
    return { err: e.message, errName: e.name };
  }
  return { err: String(e) };
}

function sanitize(fields: LogFields): LogFields {
  let out: LogFields | null = null;
  for (const key in fields) {
    const value = fields[key];
    if (REDACT_KEYS.test(key)) {
      out ??= { ...fields };
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      out ??= { ...fields };
      delete out[key];
      Object.assign(out, serializeError(value));
    }
  }
  return out ?? fields;
}

class StructuredLogger implements Logger {
  private readonly minRank: number;

  constructor(
    private readonly opts: LoggerOptions,
    private readonly bindings: LogFields = {},
  ) {
    this.minRank = LEVEL_RANK[opts.level];
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;

    const merged: LogFields = fields
      ? { ...this.bindings, ...sanitize(fields) }
      : this.bindings;
    const emit = this.opts.out ?? defaultOut;

    if (this.opts.format === 'json') {
      emit(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...merged }));
      return;
    }

    const time = new Date().toISOString().slice(11, 23);
    const mod = typeof merged.module === 'string' ? ` \x1b[35m${merged.module}\x1b[0m` : '';
    let tail = '';
    for (const key in merged) {
      if (key === 'module') continue;
      tail += ` \x1b[90m${key}=\x1b[0m${format(merged[key])}`;
    }
    emit(`\x1b[90m${time}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}${mod} ${msg}${tail}`);
  }

  trace(msg: string, fields?: LogFields): void { this.write('trace', msg, fields); }
  debug(msg: string, fields?: LogFields): void { this.write('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.write('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.write('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.write('error', msg, fields); }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(this.opts, { ...this.bindings, ...sanitize(bindings) });
  }

  async timed<T>(msg: string, fn: () => Promise<T>, fields?: LogFields): Promise<T> {
    const started = performance.now();
    try {
      const result = await fn();
      this.debug(msg, { ...fields, durationMs: round(performance.now() - started) });
      return result;
    } catch (e) {
      this.error(`${msg} failed`, {
        ...fields,
        durationMs: round(performance.now() - started),
        ...serializeError(e),
      });
      throw e;
    }
  }
}

function format(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;

function defaultOut(line: string): void {
  process.stdout.write(line + '\n');
}

export function createLogger(opts: LoggerOptions): Logger {
  return new StructuredLogger(opts);
}

/** Silent logger for tests. */
export const nullLogger: Logger = createLogger({ level: 'error', format: 'json', out: () => {} });
