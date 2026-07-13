import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StrategyType } from '../src/constants/index.js';
import { AppError } from '../src/core/errors.js';
import {
  extractPoolAddress,
  looksLikePoolInput,
  parsePresetLine,
  parsePresetLines,
  parseSolAmount,
  parseStrategy,
  rangeToBins,
  binsToRange,
  resolveSolAmount,
} from '../src/utils/parse.js';

const POOL = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';

describe('extractPoolAddress', () => {
  it('pulls the address out of a Meteora link', () => {
    assert.equal(extractPoolAddress(`https://app.meteora.ag/dlmm/${POOL}`), POOL);
  });

  it('accepts a bare address', () => {
    assert.equal(extractPoolAddress(POOL), POOL);
  });

  it('accepts the link with trailing query/fragment noise', () => {
    assert.equal(extractPoolAddress(`https://app.meteora.ag/dlmm/${POOL}?ref=x`), POOL);
  });

  /**
   * The original scanned the whole message with a global regex and took the LAST
   * base58-looking match, so trailing text could redirect where funds went.
   * These two cases are the regression guard for that.
   */
  it('does not take a trailing address from a message that also has a pool link', () => {
    const attacker = 'So11111111111111111111111111111111111111112';
    assert.equal(extractPoolAddress(`https://app.meteora.ag/dlmm/${POOL} ${attacker}`), POOL);
  });

  it('rejects a bare address embedded in surrounding prose', () => {
    assert.equal(extractPoolAddress(`send it to ${POOL} please`), null);
  });

  it('rejects junk', () => {
    assert.equal(extractPoolAddress('hello world'), null);
    assert.equal(extractPoolAddress(''), null);
    assert.equal(extractPoolAddress('0OIl'), null); // non-base58 characters
  });

  it('does not treat a slash command as pool input', () => {
    assert.equal(looksLikePoolInput(`/start ${POOL}`), false);
  });
});

describe('parseSolAmount', () => {
  it('parses max', () => {
    assert.deepEqual(parseSolAmount('max'), { kind: 'max' });
    assert.deepEqual(parseSolAmount('MAX'), { kind: 'max' });
  });

  it('parses a percentage', () => {
    assert.deepEqual(parseSolAmount('50%'), { kind: 'percent', percent: 50 });
  });

  it('parses a fixed amount', () => {
    assert.deepEqual(parseSolAmount('1.25'), { kind: 'fixed', sol: 1.25 });
  });

  it('rejects out-of-range percentages', () => {
    assert.throws(() => parseSolAmount('0%'), AppError);
    assert.throws(() => parseSolAmount('101%'), AppError);
  });

  it('rejects zero, negative and non-numeric amounts', () => {
    assert.throws(() => parseSolAmount('0'), AppError);
    assert.throws(() => parseSolAmount('-1'), AppError);
    assert.throws(() => parseSolAmount('abc'), AppError);
  });
});

describe('resolveSolAmount', () => {
  const RESERVE = 0.08;

  it('returns a fixed amount untouched', () => {
    assert.equal(resolveSolAmount({ kind: 'fixed', sol: 2 }, 10, RESERVE), 2);
  });

  it('max leaves the fee reserve behind', () => {
    assert.equal(resolveSolAmount({ kind: 'max' }, 10, RESERVE), 9.92);
  });

  it('percent applies to the usable balance, not the raw balance', () => {
    // (10 - 0.08) * 50% = 4.96 — NOT 5.
    assert.equal(resolveSolAmount({ kind: 'percent', percent: 50 }, 10, RESERVE), 4.96);
  });

  it('never returns a negative amount when the balance is below the reserve', () => {
    assert.equal(resolveSolAmount({ kind: 'max' }, 0.01, RESERVE), 0);
    assert.equal(resolveSolAmount({ kind: 'percent', percent: 100 }, 0, RESERVE), 0);
  });

  it('floors rather than rounds, so it can never size above the balance', () => {
    const out = resolveSolAmount({ kind: 'max' }, 1.000_099_9, 0);
    assert.ok(out <= 1.000_099_9);
    assert.equal(out, 1.0);
  });
});

describe('parsePresetLine', () => {
  it('parses a full line', () => {
    assert.deepEqual(parsePresetLine('SCALP max 7 bidask'), {
      id: 'SCALP',
      name: 'SCALP',
      sol: { kind: 'max' },
      range: 7,
      strategy: StrategyType.BidAsk,
    });
  });

  it('parses every strategy alias', () => {
    assert.equal(parseStrategy('spot'), StrategyType.Spot);
    assert.equal(parseStrategy('curve'), StrategyType.Curve);
    assert.equal(parseStrategy('bidask'), StrategyType.BidAsk);
    assert.equal(parseStrategy('bid-ask'), StrategyType.BidAsk);
    assert.throws(() => parseStrategy('nonsense'), AppError);
  });

  it('rejects a private key used as a name', () => {
    const fakeKey = '5'.repeat(70);
    assert.throws(() => parsePresetLine(`${fakeKey} max 7 bidask`), AppError);
  });

  it('rejects an out-of-range range', () => {
    assert.throws(() => parsePresetLine('A max 0 bidask'), AppError);
    assert.throws(() => parsePresetLine('A max 101 bidask'), AppError);
  });

  it('rejects a short line', () => {
    assert.throws(() => parsePresetLine('A max 7'), AppError);
  });
});

describe('parsePresetLines', () => {
  it('reports bad lines instead of silently dropping them', () => {
    // The original `continue`d past malformed lines, so a typo vanished with no
    // feedback at all.
    const { presets, errors } = parsePresetLines('GOOD max 7 bidask\nBAD nonsense\nALSOGOOD 1 30 spot');
    assert.equal(presets.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /BAD nonsense/);
  });

  it('ignores blank lines', () => {
    const { presets, errors } = parsePresetLines('\n\nGOOD max 7 bidask\n\n');
    assert.equal(presets.length, 1);
    assert.equal(errors.length, 0);
  });
});

describe('rangeToBins', () => {
  /**
   * DLMM bin prices are GEOMETRIC: price(n) = (1 + binStep/1e4)^n. v1 divided
   * linearly, which undershoots — so every wide preset silently opened a
   * narrower position than asked for and went out of range early.
   */
  it('uses geometric bin pricing, not linear division', () => {
    // -70% at binStep 100 (1%/bin). Linear says 70 bins. The truth is 121:
    //   1.01^121 = 3.33  ->  1 - 1/3.33 = 70%
    assert.equal(rangeToBins(70, 100), 121);
    assert.notEqual(rangeToBins(70, 100), 70, 'the linear answer would be 70 — that is the v1 bug');
  });

  it('round-trips against binsToRange', () => {
    for (const [pct, binStep] of [
      [7, 20],
      [30, 100],
      [49, 100],
      [67, 100],
      [70, 20],
    ] as const) {
      const bins = rangeToBins(pct, binStep);
      const actual = binsToRange(bins, binStep);
      assert.ok(actual >= pct, `${bins} bins reach ${actual.toFixed(2)}%, must cover the requested ${pct}%`);
      // And not wastefully wide: one bin fewer must fall short.
      assert.ok(binsToRange(bins - 1, binStep) < pct, 'should be the minimum bin count that covers the range');
    }
  });

  /**
   * The "-49%" wall, pinned. A classic position holds at most 70 bins, which at
   * binStep 100 reaches -50.17%. Anything past that needs an extended position —
   * which is exactly why -67% / -70% were unreachable before.
   */
  it('pins the classic single-position ceiling', () => {
    const reach = binsToRange(70, 100);
    assert.ok(reach > 50 && reach < 51, `70 bins at binStep 100 reach ${reach.toFixed(2)}% — the wall`);

    assert.ok(rangeToBins(50, 100) <= 70, '-50% still fits a classic position');
    assert.ok(rangeToBins(51, 100) > 70, '-51% must escalate to an extended position');
    assert.ok(rangeToBins(67, 100) > 70, '-67% must escalate to an extended position');
    assert.ok(rangeToBins(70, 100) > 70, '-70% must escalate to an extended position');
  });

  it('wide ranges stay within the 1400-bin extended limit on coarse pools', () => {
    assert.ok(rangeToBins(67, 100) <= 1400);
    assert.ok(rangeToBins(70, 100) <= 1400);
    // But a fine bin step cannot reach a wide range at all.
    assert.ok(rangeToBins(70, 4) > 1400, 'binStep 4 cannot reach -70% — must be rejected with a clear message');
  });

  it('always spans at least one bin', () => {
    assert.equal(rangeToBins(0.001, 100), 1);
  });

  it('rejects a zero bin step rather than dividing by zero', () => {
    // v1 would have produced Infinity here and passed it to the SDK.
    assert.throws(() => rangeToBins(7, 0), AppError);
  });

  it('rejects a 100% range instead of returning Infinity', () => {
    assert.throws(() => rangeToBins(100, 100), AppError);
  });
});
