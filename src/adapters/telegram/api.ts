import { recoverable } from '../../core/errors.js';
import type { HttpClient } from '../../net/http.js';
import { RateLimiter } from '../../net/rate-limiter.js';
import type { Logger } from '../../observability/logger.js';
import type { InlineKeyboard, TgResponse, TgUpdate } from '../../types/telegram.js';

const API_BASE = 'https://api.telegram.org';

/**
 * Telegram Bot API client.
 *
 * Runs over the shared keep-alive pool (the original opened a fresh TLS
 * connection per call) and is rate limited to stay inside Telegram's ~30
 * messages/second ceiling — exceeding it gets the bot throttled, and a busy
 * Extreme session emits a message per cycle.
 */
export class TelegramApi {
  private readonly limiter = new RateLimiter(20, 20);
  private readonly base: string;

  constructor(
    token: string,
    private readonly http: HttpClient,
    private readonly log: Logger,
    private readonly pollTimeoutSec: number,
  ) {
    this.base = `${API_BASE}/bot${token}`;
  }

  private async call<T>(method: string, payload: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    await this.limiter.acquire(signal);

    const res = await this.http.json<TgResponse<T>>({
      method: 'POST',
      url: `${this.base}/${method}`,
      body: payload,
      signal,
      timeoutMs,
    });

    if (!res.ok || res.result === undefined) {
      throw recoverable('telegram.apiError', `Telegram ${method} failed: ${res.description ?? 'unknown error'}`, {
        method,
        errorCode: res.error_code,
      });
    }
    return res.result;
  }

  /**
   * Long-polls for updates. The HTTP timeout is set above the long-poll timeout
   * so the socket is not torn down before Telegram replies.
   */
  async getUpdates(offset: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: this.pollTimeoutSec,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
      (this.pollTimeoutSec + 10) * 1000,
    );
  }

  async sendMessage(chatId: number, text: string, markup?: InlineKeyboard): Promise<number> {
    const msg = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    });
    return msg.message_id;
  }

  /**
   * Edits a message. Telegram returns an error when the new content is identical
   * to the old — that is not a real failure (it happens constantly on a Refresh
   * button), so it is swallowed here rather than surfaced to the user.
   */
  async editMessage(chatId: number, messageId: number, text: string, markup?: InlineKeyboard): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        ...(markup ? { reply_markup: markup } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('message is not modified')) return;
      throw e;
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    } catch (e) {
      // A stale callback (older than 60s) cannot be answered. Harmless.
      this.log.debug('answerCallbackQuery failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Best-effort deletion, used to scrub messages containing secrets. */
  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch (e) {
      this.log.warn('could not delete message', { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
}
