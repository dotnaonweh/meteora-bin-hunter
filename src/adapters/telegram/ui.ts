import type { PositionStatus, Preset, TrackedPosition, WalletMeta } from '../../types/domain.js';
import type { InlineButton, Screen } from '../../types/telegram.js';
import { shortKey, signed, solLabel, ms } from '../../utils/format.js';
import { strategyName } from '../../utils/parse.js';

/**
 * Pure screen renderers: state in, `Screen` out. No I/O, no globals.
 * Every one of these is directly unit-testable.
 */

const RULE = '━━━━━━━━━━━━━━━━━━━━';
const BACK_MAIN: InlineButton = { text: '🔙 Back', callback_data: 'menu:main' };

/** Renders a preset the same way everywhere. The original re-implemented this
 *  ternary chain inline in four separate menus, and they had already drifted. */
export function presetLabel(p: Preset): string {
  return `${p.name} (${solLabel(p.sol)} | -${p.range}% | ${strategyName(p.strategy)})`;
}

export function mainMenu(args: {
  wallet: WalletMeta | null;
  preset: Preset | null;
  extremeActive: boolean;
  extremeSessionId: string | null;
  positionCount: number;
}): Screen {
  const walletLine = args.wallet
    ? `💼 ${args.wallet.name}: ${shortKey(args.wallet.pubkey)}`
    : '💼 No wallet imported';
  const presetLine = args.preset ? `⚡ Strategy: ${presetLabel(args.preset)}` : '⚡ Strategy: none set';

  const extremeButton: InlineButton =
    args.extremeActive && args.extremeSessionId
      ? { text: '🛑 Stop Extreme', callback_data: `extreme:stop:${args.extremeSessionId}` }
      : { text: '💥 Extreme Mode', callback_data: 'menu:extreme' };

  return {
    text: [
      '🌊 METEORA BIN HUNTER',
      RULE,
      walletLine,
      presetLine,
      args.extremeActive ? '🔴 EXTREME MODE ACTIVE' : '',
      `📊 Tracked positions: ${args.positionCount}`,
      RULE,
    ]
      .filter(Boolean)
      .join('\n'),
    markup: {
      inline_keyboard: [
        [
          { text: '➕ Add LP', callback_data: 'menu:addlp' },
          { text: '📊 Positions', callback_data: 'menu:positions' },
        ],
        [
          { text: '💼 Wallet', callback_data: 'menu:wallet' },
          { text: '🌐 RPC', callback_data: 'menu:rpc' },
        ],
        [
          { text: '⚡ Strategy', callback_data: 'menu:strat' },
          { text: '💰 Balance', callback_data: 'menu:balance' },
        ],
        [
          { text: '🔄 Sync', callback_data: 'menu:sync' },
          { text: '📈 Stats', callback_data: 'menu:stats' },
        ],
        [extremeButton],
      ],
    },
  };
}

export function walletMenu(wallets: readonly WalletMeta[], activeId: string | null): Screen {
  const rows: InlineButton[][] = wallets.map((w) => [
    {
      text: `${w.id === activeId ? '✅ ' : ''}${w.name} (${shortKey(w.pubkey)})`,
      callback_data: `wallet:switch:${w.id}`,
    },
    { text: '🗑️', callback_data: `wallet:delete:${w.id}` },
  ]);

  rows.push([{ text: '➕ Import Wallet', callback_data: 'wallet:import' }]);
  rows.push([BACK_MAIN]);

  // The original's equivalent check was `buttons.length > 0`, which was always
  // true (the Import/Back rows are pushed unconditionally), so the empty-state
  // message was unreachable dead code.
  const text =
    wallets.length === 0
      ? `💼 WALLETS\n${RULE}\n\n📭 No wallets yet. Import one to get started.`
      : `💼 WALLETS\n${RULE}\n\nSelect an active wallet, or import a new one:`;

  return { text, markup: { inline_keyboard: rows } };
}

export function stratMenu(presets: readonly Preset[], activeId: string | null): Screen {
  const rows: InlineButton[][] = presets.map((p) => [
    {
      text: `${p.id === activeId ? '✅ ' : ''}${presetLabel(p)}`,
      callback_data: `strat:switch:${p.id}`,
    },
  ]);

  rows.push([{ text: '➕ Add', callback_data: 'strat:add' }]);
  if (presets.length > 0) {
    rows.push([
      { text: '✏️ Edit', callback_data: 'strat:edit_list' },
      { text: '🗑️ Delete', callback_data: 'strat:delete_list' },
    ]);
  }
  rows.push([BACK_MAIN]);

  const text =
    presets.length === 0
      ? `⚡ STRATEGY PRESETS\n${RULE}\n\n📭 No presets yet. Add one:\n<name> <sol|max|50%> <range%> <spot|curve|bidask>`
      : `⚡ STRATEGY PRESETS\n${RULE}\n\nSelect or manage a preset:`;

  return { text, markup: { inline_keyboard: rows } };
}

export function presetPickList(
  presets: readonly Preset[],
  action: 'edit' | 'delete',
): Screen {
  const icon = action === 'edit' ? '✏️' : '🗑️';
  const rows: InlineButton[][] = presets.map((p) => [
    { text: `${icon} ${presetLabel(p)}`, callback_data: `strat:${action}:${p.id}` },
  ]);
  rows.push([{ text: '🔙 Back', callback_data: 'menu:strat' }]);

  return {
    text: `${icon} ${action === 'edit' ? 'EDIT' : 'DELETE'} PRESET\n${RULE}\n\nPick one:`,
    markup: { inline_keyboard: rows },
  };
}

export function positionList(positions: readonly TrackedPosition[]): Screen {
  if (positions.length === 0) {
    return {
      text: `📊 POSITIONS\n${RULE}\n\n📭 No tracked positions.`,
      markup: { inline_keyboard: [[BACK_MAIN]] },
    };
  }

  const rows: InlineButton[][] = positions.map((p) => [
    {
      text: `🏊 ${shortKey(p.poolAddress)} — ${p.solAmount > 0 ? `${p.solAmount} SOL` : 'synced'}`,
      callback_data: `pos:view:${p.positionKey}`,
    },
  ]);
  rows.push([BACK_MAIN]);

  return {
    text: `📊 POSITIONS\n${RULE}\n\n${positions.length} tracked:`,
    markup: { inline_keyboard: rows },
  };
}

export function positionCard(status: PositionStatus): Screen {
  const size = status.solAmount > 0 ? `${status.solAmount} SOL` : 'unknown';
  const range =
    status.rangePercent > 0 ? `-${status.rangePercent}%` : `${status.maxBinId - status.minBinId + 1} bins`;

  const lines = [
    `📊 POSITION`,
    RULE,
    `🏊 Pool: ${shortKey(status.poolAddress)}`,
    `📍 Position: ${shortKey(status.positionKey)}`,
    `💰 Size: ${size} | Range: ${range}`,
    `📊 Bins: ${status.minBinId} → ${status.maxBinId} (active: ${status.currentBin})`,
    `📐 Strategy: ${strategyName(status.strategy).toUpperCase()}`,
    `📈 ${status.inRange ? '✅ In range' : '⚠️ Out of range'}`,
  ];

  if (status.pnl) {
    const p = status.pnl;
    lines.push(`💵 PnL: ${signed(p.pnlSol)} SOL (${signed(p.pnlPctChange, 2)}%)`);
    lines.push(`📊 Unrealized: ${signed(p.unrealizedPnlSol)} SOL`);
    if (p.unclaimedFeeSolX > 0 || p.unclaimedFeeSolY > 0) {
      lines.push(`🤑 Unclaimed fees: ${(p.unclaimedFeeSolX + p.unclaimedFeeSolY).toFixed(6)} SOL`);
    }
  }

  lines.push(`🕐 ${new Date(status.addedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  lines.push(RULE);

  return {
    text: lines.join('\n'),
    markup: {
      inline_keyboard: [
        [
          { text: '🗑️ Remove LP', callback_data: `pos:remove:${status.positionKey}` },
          { text: '🔄 Refresh', callback_data: `pos:view:${status.positionKey}` },
        ],
        [{ text: '🔙 Back', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export function rpcStatus(
  endpoints: ReadonlyArray<{ label: string; latencyMs: number; healthy: boolean; breaker: string }>,
): Screen {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = endpoints.map((e, i) => {
    const medal = e.healthy ? (medals[i] ?? '  ') : '❌';
    const breaker = e.breaker === 'closed' ? '' : ` [${e.breaker}]`;
    return `${medal} ${e.label}: ${e.healthy ? ms(e.latencyMs) : 'unhealthy'}${breaker}`;
  });

  return {
    text: `🌐 RPC ENDPOINTS\n${RULE}\n\n${lines.join('\n')}\n\n✅ Active: ${endpoints[0]?.label ?? 'none'}`,
    markup: { inline_keyboard: [[{ text: '🔄 Re-check', callback_data: 'menu:rpc' }], [BACK_MAIN]] },
  };
}

export function statsScreen(snapshot: {
  counters: Readonly<Record<string, number>>;
  gauges: Readonly<Record<string, number>>;
  histograms: Readonly<Record<string, { p50: number; p95: number; count: number }>>;
  process: { rssMb: number; heapUsedMb: number; uptimeSec: number };
}): Screen {
  const h = (name: string): string => {
    const stat = snapshot.histograms[name];
    if (!stat || stat.count === 0) return 'n/a';
    return `p50 ${Math.round(stat.p50)}ms / p95 ${Math.round(stat.p95)}ms`;
  };
  const c = (name: string): number => snapshot.counters[name] ?? 0;
  const ratio = (name: string): string => {
    const v = snapshot.gauges[`cache.${name}.hitRatio`];
    return v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
  };

  const uptimeMin = Math.floor(snapshot.process.uptimeSec / 60);

  return {
    text: [
      `📈 STATS`,
      RULE,
      `⏱️ Uptime: ${uptimeMin}m`,
      `🧠 Memory: ${snapshot.process.rssMb.toFixed(1)} MB RSS / ${snapshot.process.heapUsedMb.toFixed(1)} MB heap`,
      '',
      `🌐 RPC: ${h('rpc.latency')} · ${c('rpc.calls')} calls · ${c('rpc.errors')} errors`,
      `📡 WS: ${c('ws.binChanges')} bin changes · ${c('ws.suppressed')} suppressed · ${c('ws.reconnects')} reconnects`,
      `📝 TX: ${h('tx.latency')} · ${c('tx.confirmed')} confirmed · ${c('tx.retries')} retries`,
      `💥 Extreme: ${c('extreme.cycles')} cycles · ${c('extreme.rebalances')} rebalances · ${c('extreme.errors')} errors`,
      '',
      `💾 Cache hit ratio — pool: ${ratio('pool')} · state: ${ratio('poolState')} · pnl: ${ratio('pnl')}`,
      `🚫 Rejected (unauthorized): ${c('auth.rejected')}`,
      RULE,
    ].join('\n'),
    markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'menu:stats' }], [BACK_MAIN]] },
  };
}

export function errorScreen(message: string, backTo = 'menu:main'): Screen {
  return {
    text: `❌ ${message}`,
    markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: backTo }]] },
  };
}

export function extremeIntro(preset: Preset | null, pollMs: number): Screen {
  if (!preset) {
    return {
      text: `💥 EXTREME MODE\n${RULE}\n\n⚠️ No preset set. Create one, or start with MAX SOL.`,
      markup: {
        inline_keyboard: [
          [{ text: '💰 Use MAX SOL', callback_data: 'extreme:start:max' }],
          [{ text: '⚡ Create a preset', callback_data: 'menu:strat' }],
          [BACK_MAIN],
        ],
      },
    };
  }

  return {
    text: [
      `💥 EXTREME MODE`,
      RULE,
      '',
      '🎯 1 bin · BidAsk · auto-rebalance',
      `⏱️ Reacts to bin changes over websocket (fallback poll ${pollMs}ms)`,
      `💰 Size: ${solLabel(preset.sol)}`,
      '',
      '⚠️ EXPERIMENTAL. Trades continuously and automatically.',
      'You can lose funds. Stop it to halt further trades.',
      '',
      'Paste a Meteora pool link to begin:',
    ].join('\n'),
    markup: {
      inline_keyboard: [
        [{ text: `💰 Use ${solLabel(preset.sol)}`, callback_data: `extreme:start:${preset.id}` }],
        [BACK_MAIN],
      ],
    },
  };
}

export function stopButton(sessionId: string): InlineButton {
  return { text: '🛑 Stop Extreme', callback_data: `extreme:stop:${sessionId}` };
}
