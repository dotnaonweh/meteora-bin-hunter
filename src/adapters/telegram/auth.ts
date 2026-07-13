import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';

/**
 * Authorization gate.
 *
 * THE most important control in this codebase. The original had none at all:
 * `handleTgMessage` accepted every chat id it was given, so any Telegram user
 * who found the bot could add liquidity from the owner's wallet, remove it,
 * start Extreme Mode, read balances, or import and delete wallets.
 *
 * The allowlist is required config — `loadConfig` refuses to start without it,
 * so there is no "empty means allow all" default to accidentally ship.
 */
export class AuthGate {
  constructor(
    private readonly owners: ReadonlySet<number>,
    private readonly log: Logger,
    private readonly metrics: Metrics,
  ) {}

  /** True when this chat may control the bot. */
  isAuthorized(chatId: number, userId?: number): boolean {
    // The chat must be an owner chat, and — in a group — the acting user must
    // also be an owner. Checking only the chat would let anyone in a group that
    // an owner added the bot to drive it.
    if (!this.owners.has(chatId)) return false;
    if (userId !== undefined && !this.owners.has(userId) && userId !== chatId) {
      // Owner chat, but the message came from someone else in it.
      return false;
    }
    return true;
  }

  /** Records and logs a rejected attempt. */
  reject(chatId: number, userId: number | undefined, what: string): void {
    this.metrics.increment('auth.rejected');
    this.log.warn('rejected unauthorized request', { chatId, userId, what });
  }
}
