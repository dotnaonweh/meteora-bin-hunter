/**
 * Every failure in the system is classified into exactly one of these.
 * Callers branch on the class, never on message strings.
 *
 *  - `retryable`   transient; the same call may succeed if repeated
 *                  (RPC 429/5xx, socket reset, blockhash expired).
 *  - `recoverable` the operation failed for good, but the process is healthy
 *                  and the user can be told (bad input, insufficient SOL).
 *  - `fatal`       the process cannot continue (missing token, bad config).
 */
export type Severity = 'retryable' | 'recoverable' | 'fatal';

export class AppError extends Error {
  readonly severity: Severity;
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    severity: Severity,
    context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'AppError';
    this.code = code;
    this.severity = severity;
    this.context = context;
  }
}

export const retryable = (code: string, msg: string, ctx?: Record<string, unknown>, cause?: unknown): AppError =>
  new AppError(code, msg, 'retryable', ctx, { cause });

export const recoverable = (code: string, msg: string, ctx?: Record<string, unknown>, cause?: unknown): AppError =>
  new AppError(code, msg, 'recoverable', ctx, { cause });

export const fatal = (code: string, msg: string, ctx?: Record<string, unknown>, cause?: unknown): AppError =>
  new AppError(code, msg, 'fatal', ctx, { cause });

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** HTTP status codes and socket errors that are worth retrying. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_SYSCALL = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Classify an unknown thrown value. Anything we cannot positively identify as
 * transient is treated as `recoverable` — we would rather surface a failure to
 * the user than silently hammer an endpoint that is rejecting us for a real
 * reason.
 */
export function classify(e: unknown): AppError {
  if (isAppError(e)) return e;

  const msg = errorMessage(e);
  const code = (e as { code?: unknown })?.code;
  const status = (e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;

  if (typeof code === 'string' && RETRYABLE_SYSCALL.has(code)) {
    return retryable('net.transport', msg, { code }, e);
  }
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) {
    return retryable('net.status', msg, { status }, e);
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return retryable('net.timeout', msg, {}, e);
  }

  // Solana-specific transients. These arrive as plain Errors with no code.
  if (
    /blockhash not found|block height exceeded|node is behind|too many requests|rate ?limit|429|timed out awaiting confirmation/i.test(
      msg,
    )
  ) {
    return retryable('rpc.transient', msg, {}, e);
  }

  return recoverable('unknown', msg, {}, e);
}
