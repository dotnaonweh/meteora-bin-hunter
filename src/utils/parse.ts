import { BASE58_ADDRESS_RE, BASE58_SECRET_RE, StrategyType } from '../constants/index.js';
import type { StrategyTypeValue } from '../constants/index.js';
import { recoverable } from '../core/errors.js';
import type { Preset, SolAmount } from '../types/domain.js';

/**
 * Pure parsers. No I/O, no SDK, no global state — this is the layer the unit
 * tests exercise directly.
 */

export function parseStrategy(input: string): StrategyTypeValue {
  switch (input.trim().toLowerCase()) {
    case 'curve':
      return StrategyType.Curve;
    case 'bidask':
    case 'bid-ask':
      return StrategyType.BidAsk;
    case 'spot':
      return StrategyType.Spot;
    default:
      throw recoverable('parse.strategy', `Unknown strategy "${input}". Use spot, curve or bidask.`);
  }
}

export function strategyName(s: StrategyTypeValue | 'synced'): string {
  if (s === 'synced') return 'synced';
  switch (s) {
    case StrategyType.Curve:
      return 'curve';
    case StrategyType.BidAsk:
      return 'bidask';
    default:
      return 'spot';
  }
}

/** `max` | `50%` | `1.25` */
export function parseSolAmount(input: string): SolAmount {
  const raw = input.trim().toLowerCase();

  if (raw === 'max') return { kind: 'max' };

  if (raw.endsWith('%')) {
    const percent = Number(raw.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      throw recoverable('parse.sol', 'Percentage must be between 0 and 100');
    }
    return { kind: 'percent', percent };
  }

  const sol = Number(raw);
  if (!Number.isFinite(sol) || sol <= 0) {
    throw recoverable('parse.sol', `Invalid SOL amount "${input}". Use a number, a percentage, or "max".`);
  }
  return { kind: 'fixed', sol };
}

/**
 * Resolves a `SolAmount` against a live balance.
 * Pure: the balance is passed in, so this is trivially testable.
 */
export function resolveSolAmount(amount: SolAmount, balanceSol: number, feeReserveSol: number): number {
  if (amount.kind === 'fixed') return amount.sol;

  const usable = Math.max(0, balanceSol - feeReserveSol);
  const raw = amount.kind === 'max' ? usable : (usable * amount.percent) / 100;
  // 4dp keeps lamport conversion exact enough while avoiding float dust.
  return Math.floor(raw * 10_000) / 10_000;
}

/** `<name> <sol|max|50%> <range%> <spot|curve|bidask>` */
export function parsePresetLine(line: string): Preset {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) {
    throw recoverable('parse.preset', 'Expected: <name> <sol|max|50%> <range%> <spot|curve|bidask>');
  }
  const [name, sol, range, strategy] = parts as [string, string, string, string];

  if (BASE58_SECRET_RE.test(name)) {
    throw recoverable('parse.preset', 'That looks like a private key, not a preset name.');
  }
  if (name.length > 30) {
    throw recoverable('parse.preset', 'Preset name must be 30 characters or fewer.');
  }

  const rangePercent = Number(range);
  if (!Number.isFinite(rangePercent) || rangePercent <= 0 || rangePercent > 100) {
    throw recoverable('parse.preset', `Range must be between 0 and 100, got "${range}"`);
  }

  return {
    id: name,
    name,
    sol: parseSolAmount(sol),
    range: rangePercent,
    strategy: parseStrategy(strategy),
  };
}

/** Parses multiple preset lines, reporting per-line failures instead of silently
 *  skipping them (the original `continue`d on any malformed line). */
export function parsePresetLines(text: string): { presets: Preset[]; errors: string[] } {
  const presets: Preset[] = [];
  const errors: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      presets.push(parsePresetLine(trimmed));
    } catch (e) {
      errors.push(`"${trimmed}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { presets, errors };
}

/**
 * Extracts a pool address from a pasted Meteora link or bare address.
 *
 * Deliberately stricter than the original, which ran a global regex over the
 * whole message and took the **last** match — so any base58-looking token
 * anywhere in the text could redirect where funds went. Here we only accept the
 * path segment of a Meteora DLMM URL, or a message that is *entirely* one
 * address.
 */
export function extractPoolAddress(input: string): string | null {
  const text = input.trim();

  const urlMatch = /(?:app\.)?meteora\.ag\/dlmm\/([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(text);
  if (urlMatch?.[1]) return urlMatch[1];

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;

  return null;
}

export function looksLikePoolInput(text: string): boolean {
  if (text.startsWith('/')) return false;
  return extractPoolAddress(text) !== null;
}

export function looksLikeSecretKey(text: string): boolean {
  return BASE58_SECRET_RE.test(text.trim());
}

/** Number of bins spanned by a percentage range at a given bin step.
 *  A bin step is in basis points, so each bin is `binStep/10000` wide. */
export function rangeToBins(rangePercent: number, binStep: number): number {
  if (binStep <= 0) throw recoverable('parse.binStep', 'Pool has an invalid bin step');
  return Math.max(1, Math.ceil(rangePercent / 100 / (binStep / 10_000)));
}

/** Every base58-looking address in a blob of text. Used only for redaction checks. */
export function allAddresses(text: string): string[] {
  return text.match(BASE58_ADDRESS_RE) ?? [];
}
