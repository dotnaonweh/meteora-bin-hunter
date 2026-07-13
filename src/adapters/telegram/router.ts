import type { Config } from '../../config/index.js';
import type { DlmmClient } from '../dlmm/client.js';
import { classify } from '../../core/errors.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import type { RpcPool } from '../../providers/rpc/endpoint-pool.js';
import type { ExtremeManager } from '../../services/extreme/manager.js';
import type { LiquidityService } from '../../services/liquidity.js';
import type { PositionService } from '../../services/positions.js';
import type { PresetRegistry } from '../../state/presets.js';
import type { PositionRegistry } from '../../state/positions.js';
import type { WalletRegistry } from '../../state/wallets.js';
import type { Preset, SolAmount } from '../../types/domain.js';
import type { Screen, TgCallbackQuery, TgMessage } from '../../types/telegram.js';
import { shortKey, solLabel } from '../../utils/format.js';
import {
  extractPoolAddress,
  looksLikePoolInput,
  looksLikeSecretKey,
  parsePresetLine,
  parsePresetLines,
  parseSolAmount,
} from '../../utils/parse.js';
import type { TelegramApi } from './api.js';
import type { AuthGate } from './auth.js';
import * as ui from './ui.js';

/** Multi-step conversation state, with a TTL so an abandoned flow cannot pin a
 *  half-entered secret in memory indefinitely. */
type Flow =
  | { readonly step: 'import_name' }
  | { readonly step: 'import_pk'; readonly name: string }
  | { readonly step: 'strat_add' }
  | { readonly step: 'strat_edit'; readonly id: string }
  | { readonly step: 'extreme_pool'; readonly sol: SolAmount };

interface FlowEntry {
  readonly flow: Flow;
  readonly timer: NodeJS.Timeout;
}

export interface RouterDeps {
  readonly api: TelegramApi;
  readonly auth: AuthGate;
  readonly dlmm: DlmmClient;
  readonly liquidity: LiquidityService;
  readonly positionsService: PositionService;
  readonly extreme: ExtremeManager;
  readonly wallets: WalletRegistry;
  readonly presets: PresetRegistry;
  readonly positions: PositionRegistry;
  readonly rpc: RpcPool;
  readonly cfg: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const FLOW_TTL_MS = 10 * 60_000;

export class Router {
  private readonly flows = new Map<number, FlowEntry>();
  private readonly log: Logger;

  constructor(private readonly d: RouterDeps) {
    this.log = d.logger.child({ module: 'router' });
  }

  // --- flow state -------------------------------------------------------

  private setFlow(chatId: number, flow: Flow): void {
    this.clearFlow(chatId);
    const timer = setTimeout(() => this.flows.delete(chatId), FLOW_TTL_MS);
    timer.unref();
    this.flows.set(chatId, { flow, timer });
  }

  private clearFlow(chatId: number): void {
    const existing = this.flows.get(chatId);
    if (existing) {
      clearTimeout(existing.timer);
      this.flows.delete(chatId);
    }
  }

  // --- entry points -----------------------------------------------------

  async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    // Authorization is enforced here, before ANY handler runs and before any
    // wallet or chain state is touched.
    if (!this.d.auth.isAuthorized(chatId, msg.from?.id)) {
      this.d.auth.reject(chatId, msg.from?.id, 'message');
      // If an unauthorized user pasted what looks like a key, scrub it anyway —
      // we will not act on it, but leaving it sitting in a chat helps nobody.
      if (looksLikeSecretKey(text)) {
        await this.d.api.deleteMessage(chatId, msg.message_id).catch(() => {});
      }
      return;
    }

    try {
      await this.route(chatId, text.trim(), msg.message_id);
    } catch (e) {
      const err = classify(e);
      this.log.error('message handler failed', { chatId, err: err.message, code: err.code });
      await this.send(chatId, ui.errorScreen(err.message));
    }
  }

  async handleCallback(cb: TgCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat.id;
    const messageId = cb.message?.message_id;
    const data = cb.data;
    if (chatId === undefined || messageId === undefined || !data) return;

    if (!this.d.auth.isAuthorized(chatId, cb.from?.id)) {
      this.d.auth.reject(chatId, cb.from?.id, `callback:${data}`);
      await this.d.api.answerCallback(cb.id, 'Not authorized');
      return;
    }

    await this.d.api.answerCallback(cb.id);

    try {
      await this.routeCallback(chatId, messageId, data);
    } catch (e) {
      const err = classify(e);
      this.log.error('callback handler failed', { chatId, data, err: err.message, code: err.code });
      await this.edit(chatId, messageId, ui.errorScreen(err.message));
    }
  }

  // --- messages ---------------------------------------------------------

  private async route(chatId: number, text: string, messageId: number): Promise<void> {
    const entry = this.flows.get(chatId);

    if (entry) {
      await this.continueFlow(chatId, messageId, text, entry.flow);
      return;
    }

    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.send(chatId, this.mainMenu(chatId));
      return;
    }

    // Auto-LP: a bare pool link uses the active preset.
    if (looksLikePoolInput(text)) {
      await this.autoAddLp(chatId, text);
      return;
    }
  }

  private async continueFlow(chatId: number, messageId: number, text: string, flow: Flow): Promise<void> {
    switch (flow.step) {
      case 'import_name': {
        if (looksLikeSecretKey(text)) {
          await this.d.api.deleteMessage(chatId, messageId).catch(() => {});
          await this.send(chatId, {
            text: '❌ That looks like a private key, not a name. I deleted it.\n\nSend a NAME first (e.g. "Main"):',
          });
          return;
        }
        if (text.length > 30) {
          await this.send(chatId, { text: '❌ Name too long (max 30 characters). Try again:' });
          return;
        }
        this.setFlow(chatId, { step: 'import_pk', name: text });
        await this.send(chatId, {
          text: `✏️ Now send the private key for "${text}".\n\n⚠️ I will delete your message immediately after reading it.`,
        });
        return;
      }

      case 'import_pk': {
        // Delete FIRST, and wait for it, before doing anything that could throw.
        // The original fired the delete without awaiting, so an invalid key threw
        // and left the secret sitting in the chat.
        await this.d.api.deleteMessage(chatId, messageId);

        try {
          const meta = this.d.wallets.add(flow.name, text);
          this.clearFlow(chatId);
          await this.send(chatId, {
            text: `✅ Wallet "${meta.name}" imported.\n📍 ${shortKey(meta.pubkey)}\n\n🗑️ Your key message was deleted.`,
            markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] },
          });
        } catch (e) {
          await this.send(chatId, {
            text: `❌ ${classify(e).message}\n\nSend the private key again:`,
          });
        }
        return;
      }

      case 'strat_add': {
        const { presets, errors } = parsePresetLines(text);
        if (presets.length === 0) {
          await this.send(chatId, {
            text:
              `❌ Nothing valid parsed.\n\nFormat: <name> <sol|max|50%> <range%> <spot|curve|bidask>\n\n` +
              `Example:\nSCALP max 7 bidask\nSAFE 1 30 spot` +
              (errors.length ? `\n\nErrors:\n${errors.join('\n')}` : ''),
          });
          return;
        }

        for (const p of presets) this.d.presets.upsert(p);
        const last = presets[presets.length - 1]!;
        this.d.presets.switch(last.id);
        this.clearFlow(chatId);

        const lines = presets.map((p) => `• ${ui.presetLabel(p)}`).join('\n');
        // Report partial failures instead of silently dropping them.
        const errLines = errors.length ? `\n\n⚠️ Skipped:\n${errors.join('\n')}` : '';

        await this.send(chatId, {
          text: `✅ ${presets.length} preset(s) saved.\n${lines}\n\nActive: ${last.name}${errLines}`,
          markup: {
            inline_keyboard: [
              [{ text: '⚡ Presets', callback_data: 'menu:strat' }],
              [{ text: '🏠 Main Menu', callback_data: 'menu:main' }],
            ],
          },
        });
        return;
      }

      case 'strat_edit': {
        // Re-use the same parser by re-attaching the (unchanged) name.
        let preset: Preset;
        try {
          preset = parsePresetLine(`${flow.id} ${text}`);
        } catch (e) {
          await this.send(chatId, {
            text: `❌ ${classify(e).message}\n\nFormat: <sol|max|50%> <range%> <spot|curve|bidask>`,
          });
          return;
        }
        this.d.presets.upsert(preset);
        this.clearFlow(chatId);
        await this.send(chatId, {
          text: `✅ Updated: ${ui.presetLabel(preset)}`,
          markup: ui.stratMenu(this.d.presets.list(), this.d.presets.active()?.id ?? null).markup,
        });
        return;
      }

      case 'extreme_pool': {
        const pool = extractPoolAddress(text);
        if (!pool) {
          await this.send(chatId, { text: '❌ Not a valid Meteora pool link or address. Try again:' });
          return;
        }
        this.clearFlow(chatId);
        await this.startExtreme(chatId, pool, flow.sol);
        return;
      }
    }
  }

  // --- callbacks --------------------------------------------------------

  private async routeCallback(chatId: number, messageId: number, data: string): Promise<void> {
    const [ns = '', action = '', ...rest] = data.split(':');
    const param = rest.join(':');

    switch (`${ns}:${action}`) {
      case 'menu:main':
        this.clearFlow(chatId);
        return this.edit(chatId, messageId, this.mainMenu(chatId));

      case 'menu:balance': {
        const wallet = this.d.wallets.activeMeta;
        if (!wallet) return this.edit(chatId, messageId, ui.errorScreen('No active wallet.'));
        const kp = this.d.wallets.requireActive();
        const balance = await this.d.dlmm.solBalance(kp.publicKey);
        return this.edit(chatId, messageId, {
          text: `💰 BALANCE\n━━━━━━━━━━━━━━━━━━━━\n💼 ${wallet.name}\n📍 ${shortKey(wallet.pubkey)}\n\n💎 ${balance.toFixed(4)} SOL`,
          markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] },
        });
      }

      case 'menu:rpc': {
        await this.edit(chatId, messageId, { text: '⏳ Checking RPC endpoints...' });
        await this.d.rpc.healthCheck();
        return this.edit(chatId, messageId, ui.rpcStatus(this.d.rpc.status()));
      }

      case 'menu:stats':
        return this.edit(chatId, messageId, ui.statsScreen(this.d.metrics.snapshot()));

      case 'menu:sync': {
        await this.edit(chatId, messageId, { text: '⏳ Syncing positions from chain...' });
        const result = await this.d.positionsService.sync();
        return this.edit(chatId, messageId, {
          text: `🔄 SYNC COMPLETE\n━━━━━━━━━━━━━━━━━━━━\n\n✅ ${result.added} adopted\n🗑️ ${result.removed} closed\n📊 On-chain: ${result.total}\n📋 Tracked: ${this.d.positions.size}`,
          markup: {
            inline_keyboard: [
              [{ text: '📊 Positions', callback_data: 'menu:positions' }],
              [{ text: '🏠 Main Menu', callback_data: 'menu:main' }],
            ],
          },
        });
      }

      case 'menu:addlp': {
        const preset = this.d.presets.active();
        return this.edit(chatId, messageId, {
          text: preset
            ? `➕ ADD LP\n━━━━━━━━━━━━━━━━━━━━\n\nPaste a Meteora pool link in chat and I'll add LP with the active preset:\n\n⚡ ${ui.presetLabel(preset)}`
            : `➕ ADD LP\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ No preset set. Create one first.`,
          markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu:main' }]] },
        });
      }

      case 'menu:positions':
        return this.edit(chatId, messageId, ui.positionList(this.d.positions.list()));

      case 'menu:wallet':
        return this.edit(
          chatId,
          messageId,
          ui.walletMenu(this.d.wallets.list(), this.d.wallets.activeMeta?.id ?? null),
        );

      case 'menu:strat':
        return this.edit(
          chatId,
          messageId,
          ui.stratMenu(this.d.presets.list(), this.d.presets.active()?.id ?? null),
        );

      case 'menu:extreme':
        return this.edit(
          chatId,
          messageId,
          ui.extremeIntro(this.d.presets.active(), this.d.cfg.extreme.pollIntervalMs),
        );

      case 'extreme:start': {
        // `param` is a preset id, or the literal "max" for the no-preset path.
        const sol: SolAmount =
          param === 'max' ? { kind: 'max' } : (this.d.presets.get(param)?.sol ?? parseSolAmount(param));

        this.setFlow(chatId, { step: 'extreme_pool', sol });
        return this.edit(chatId, messageId, {
          text: `💥 EXTREME MODE\n━━━━━━━━━━━━━━━━━━━━\n\n💰 Size: ${solLabel(sol)}\n\nPaste the Meteora pool link:`,
          markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:main' }]] },
        });
      }

      case 'extreme:stop': {
        // The session id is the owner's chat id. Only the owner of a session may
        // stop it — the original took the target chat id straight from the
        // callback payload, so one user could stop another's session.
        if (param !== String(chatId)) {
          return this.edit(chatId, messageId, ui.errorScreen('That session does not belong to you.'));
        }
        const cycles = await this.d.extreme.stop(param);
        return this.edit(chatId, messageId, {
          text: `🛑 EXTREME MODE STOPPED\n━━━━━━━━━━━━━━━━━━━━\n\nCycles completed: ${cycles}\n\n⚠️ The position is still open on-chain. Remove it from Positions if you want out.`,
          markup: {
            inline_keyboard: [
              [{ text: '📊 Positions', callback_data: 'menu:positions' }],
              [{ text: '🏠 Main Menu', callback_data: 'menu:main' }],
            ],
          },
        });
      }

      case 'strat:switch': {
        const preset = this.d.presets.switch(param);
        const menu = ui.stratMenu(this.d.presets.list(), preset.id);
        return this.edit(chatId, messageId, {
          text: `✅ Active: ${ui.presetLabel(preset)}\n\n${menu.text}`,
          markup: menu.markup,
        });
      }

      case 'strat:add':
        this.setFlow(chatId, { step: 'strat_add' });
        return this.edit(chatId, messageId, {
          text:
            '➕ ADD PRESET\n━━━━━━━━━━━━━━━━━━━━\n\nOne per line:\n<name> <sol|max|50%> <range%> <spot|curve|bidask>\n\n' +
            'Examples:\nSCALP max 7 bidask\nSAFE 1 30 spot\nHALF 50% 5 bidask',
          markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:strat' }]] },
        });

      case 'strat:edit_list':
        return this.edit(chatId, messageId, ui.presetPickList(this.d.presets.list(), 'edit'));

      case 'strat:delete_list':
        return this.edit(chatId, messageId, ui.presetPickList(this.d.presets.list(), 'delete'));

      case 'strat:edit': {
        const preset = this.d.presets.get(param);
        if (!preset) return this.edit(chatId, messageId, ui.errorScreen('Preset not found.', 'menu:strat'));
        this.setFlow(chatId, { step: 'strat_edit', id: param });
        return this.edit(chatId, messageId, {
          text: `✏️ Editing "${param}"\nCurrent: ${ui.presetLabel(preset)}\n\nSend new values:\n<sol|max|50%> <range%> <spot|curve|bidask>`,
          markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'strat:edit_list' }]] },
        });
      }

      case 'strat:delete': {
        this.d.presets.remove(param);
        const menu = ui.stratMenu(this.d.presets.list(), this.d.presets.active()?.id ?? null);
        return this.edit(chatId, messageId, { text: `✅ Deleted "${param}".\n\n${menu.text}`, markup: menu.markup });
      }

      case 'wallet:import':
        this.setFlow(chatId, { step: 'import_name' });
        return this.edit(chatId, messageId, {
          text: '💼 IMPORT WALLET\n━━━━━━━━━━━━━━━━━━━━\n\nSend a name for this wallet:',
          markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu:wallet' }]] },
        });

      case 'wallet:switch': {
        const meta = this.d.wallets.switch(param);
        const menu = ui.walletMenu(this.d.wallets.list(), meta.id);
        return this.edit(chatId, messageId, { text: `✅ Active: ${meta.name}\n\n${menu.text}`, markup: menu.markup });
      }

      case 'wallet:delete': {
        const meta = this.d.wallets.list().find((w) => w.id === param);
        if (!meta) return this.edit(chatId, messageId, ui.errorScreen('Wallet not found.', 'menu:wallet'));
        return this.edit(chatId, messageId, {
          text: `🗑️ Delete wallet "${meta.name}"?\n📍 ${meta.pubkey}\n\n⚠️ Its private key will be removed from .env. This cannot be undone.`,
          markup: {
            inline_keyboard: [
              [
                { text: '✅ Yes, delete', callback_data: `wallet:confirmdelete:${param}` },
                { text: '❌ Cancel', callback_data: 'menu:wallet' },
              ],
            ],
          },
        });
      }

      case 'wallet:confirmdelete': {
        const meta = this.d.wallets.list().find((w) => w.id === param);
        const name = meta?.name ?? param;
        this.d.wallets.remove(param);
        const menu = ui.walletMenu(this.d.wallets.list(), this.d.wallets.activeMeta?.id ?? null);
        return this.edit(chatId, messageId, { text: `✅ Deleted "${name}".\n\n${menu.text}`, markup: menu.markup });
      }

      case 'pos:view': {
        const status = await this.d.positionsService.status(param);
        return this.edit(chatId, messageId, ui.positionCard(status));
      }

      case 'pos:remove': {
        await this.edit(chatId, messageId, { text: `⏳ Removing LP ${shortKey(param)}...` });
        const signatures = await this.d.liquidity.removeLiquidity(param);
        return this.edit(chatId, messageId, {
          text: `✅ LP REMOVED\n━━━━━━━━━━━━━━━━━━━━\n🔗 ${signatures[0] ?? 'n/a'}`,
          markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu:main' }]] },
        });
      }

      default:
        this.log.warn('unknown callback', { data });
        return;
    }
  }

  // --- actions ----------------------------------------------------------

  private async autoAddLp(chatId: number, text: string): Promise<void> {
    const pool = extractPoolAddress(text);
    if (!pool) return;

    const preset = this.d.presets.active();
    if (!preset) {
      await this.send(chatId, ui.errorScreen('No strategy preset set. Create one first.'));
      return;
    }
    if (!this.d.wallets.activeMeta) {
      await this.send(chatId, ui.errorScreen('No wallet imported.'));
      return;
    }

    await this.send(chatId, {
      text: `⚡ Adding LP...\n🏊 ${shortKey(pool)}\n⚡ ${ui.presetLabel(preset)}`,
    });

    const result = await this.d.liquidity.addLiquidity(pool, preset);

    await this.send(chatId, {
      text: [
        '✅ LP ADDED',
        '━━━━━━━━━━━━━━━━━━━━',
        `📍 ${shortKey(result.positionKey)}`,
        `💰 ${result.solUsed} SOL`,
        `📊 Bins ${result.minBinId} → ${result.maxBinId} (active ${result.activeBinId})`,
        `🔗 ${result.signature}`,
      ].join('\n'),
      markup: {
        inline_keyboard: [
          [{ text: '📊 View position', callback_data: `pos:view:${result.positionKey}` }],
          [{ text: '🏠 Main Menu', callback_data: 'menu:main' }],
        ],
      },
    });
  }

  private async startExtreme(chatId: number, poolAddress: string, sol: SolAmount): Promise<void> {
    const owner = this.d.wallets.requireActive();
    const sessionId = String(chatId);

    if (this.d.extreme.has(sessionId)) {
      await this.send(chatId, ui.errorScreen('An Extreme session is already running. Stop it first.'));
      return;
    }

    await this.send(chatId, {
      text: `💥 Starting Extreme Mode...\n🏊 ${shortKey(poolAddress)}\n💰 ${solLabel(sol)}\n🎯 1 bin · BidAsk`,
    });

    // The session emits events; the router is what turns them into messages.
    // This keeps the trading engine free of any Telegram dependency.
    await this.d.extreme.start({
      id: sessionId,
      poolAddress,
      owner,
      solAmount: sol,
      events: {
        onOpened: (info) => {
          void this.send(chatId, {
            text: [
              '✅ EXTREME MODE ACTIVE',
              '━━━━━━━━━━━━━━━━━━━━',
              `📍 ${shortKey(info.positionKey)}`,
              `🎯 Target bin: ${info.targetBinId}`,
              `💰 ${info.solUsed} SOL`,
              `🔗 ${info.signature}`,
            ].join('\n'),
            markup: { inline_keyboard: [[ui.stopButton(sessionId)]] },
          });
        },
        onRebalanced: (info) => {
          void this.send(chatId, {
            text: info.signature
              ? `⚠️ Out of range — re-added to bin ${info.targetBinId}\n🔗 ${info.signature}\n\n👀 Waiting for price to return...`
              : `⚠️ Out of range — no token balance to re-add.\n\n👀 Waiting for price to return...`,
            markup: { inline_keyboard: [[ui.stopButton(sessionId)]] },
          });
        },
        onCycle: (info) => {
          void this.send(chatId, {
            text: [
              `✅ Cycle #${info.cycle} (${info.reason})`,
              `🎯 New bin: ${info.targetBinId}`,
              `💰 ${info.solUsed} SOL`,
              `🔗 ${info.signature}`,
            ].join('\n'),
            markup: { inline_keyboard: [[ui.stopButton(sessionId)]] },
          });
        },
        onHalted: (info) => {
          void this.send(chatId, {
            text: `🛑 EXTREME MODE HALTED\n━━━━━━━━━━━━━━━━━━━━\n\nReason: ${info.reason}\nCycles: ${info.cycles}\n\n⚠️ Any open position is still on-chain.`,
            markup: {
              inline_keyboard: [
                [{ text: '📊 Positions', callback_data: 'menu:positions' }],
                [{ text: '🏠 Main Menu', callback_data: 'menu:main' }],
              ],
            },
          });
        },
        onError: (info) => {
          void this.send(chatId, {
            text: `⚠️ Extreme ${info.fatal ? 'fatal error' : 'error'}: ${info.message}`,
            markup: { inline_keyboard: [[ui.stopButton(sessionId)]] },
          });
        },
      },
    });
  }

  // --- helpers ----------------------------------------------------------

  private mainMenu(chatId: number): Screen {
    const sessionId = String(chatId);
    return ui.mainMenu({
      wallet: this.d.wallets.activeMeta,
      preset: this.d.presets.active(),
      extremeActive: this.d.extreme.has(sessionId),
      extremeSessionId: sessionId,
      positionCount: this.d.positions.size,
    });
  }

  private async send(chatId: number, screen: Screen): Promise<void> {
    await this.d.api.sendMessage(chatId, screen.text, screen.markup);
  }

  private async edit(chatId: number, messageId: number, screen: Screen): Promise<void> {
    await this.d.api.editMessage(chatId, messageId, screen.text, screen.markup);
  }

  /** Clears every pending flow. Called on shutdown so no secret-bearing state
   *  outlives the process. */
  dispose(): void {
    for (const { timer } of this.flows.values()) clearTimeout(timer);
    this.flows.clear();
  }
}
