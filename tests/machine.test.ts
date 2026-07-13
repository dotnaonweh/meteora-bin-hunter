import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, singleBinRange, type ExtremeSnapshot } from '../src/services/extreme/machine.js';

const NO_LIMIT = { maxCycles: 0 };

function snap(over: Partial<ExtremeSnapshot> = {}): ExtremeSnapshot {
  return { phase: 'active', targetBinId: 100, cycleCount: 0, ...over };
}

/**
 * These assertions encode the ORIGINAL bot's behaviour exactly. They exist so a
 * future change to the rebalance logic cannot silently alter the strategy: if
 * one of these flips, the bot is trading differently than it used to.
 */
describe('extreme decision machine', () => {
  describe('phase: active', () => {
    it('cycles when price moves right of the target bin', () => {
      assert.deepEqual(decide(snap(), 101, NO_LIMIT), { kind: 'cycle', reason: 'right-oor' });
    });

    it('rebalances when price moves left of the target bin', () => {
      assert.deepEqual(decide(snap(), 99, NO_LIMIT), { kind: 'rebalance' });
    });

    it('does nothing while price sits exactly on the target bin', () => {
      assert.deepEqual(decide(snap(), 100, NO_LIMIT), { kind: 'idle' });
    });

    it('cycles on any bin strictly greater, not just adjacent', () => {
      assert.deepEqual(decide(snap(), 5_000, NO_LIMIT), { kind: 'cycle', reason: 'right-oor' });
    });
  });

  describe('phase: waiting', () => {
    it('cycles when price returns TO the target bin (inclusive)', () => {
      // The original used `>=` here but `>` in the active phase. That asymmetry
      // is deliberate and is preserved.
      assert.deepEqual(decide(snap({ phase: 'waiting' }), 100, NO_LIMIT), {
        kind: 'cycle',
        reason: 'returned',
      });
    });

    it('cycles when price overshoots past the target', () => {
      assert.deepEqual(decide(snap({ phase: 'waiting' }), 150, NO_LIMIT), {
        kind: 'cycle',
        reason: 'returned',
      });
    });

    it('keeps waiting while price is still below the target', () => {
      assert.deepEqual(decide(snap({ phase: 'waiting' }), 99, NO_LIMIT), { kind: 'idle' });
    });
  });

  describe('phases that take no action', () => {
    it('is idle while a cycle is executing, whatever the price does', () => {
      for (const bin of [1, 99, 100, 101, 9_999]) {
        assert.deepEqual(decide(snap({ phase: 'executing' }), bin, NO_LIMIT), { kind: 'idle' });
      }
    });

    it('is idle once stopped', () => {
      for (const bin of [1, 100, 9_999]) {
        assert.deepEqual(decide(snap({ phase: 'stopped' }), bin, NO_LIMIT), { kind: 'idle' });
      }
    });
  });

  describe('circuit breaker', () => {
    it('halts once the cycle limit is reached', () => {
      const d = decide(snap({ cycleCount: 5 }), 101, { maxCycles: 5 });
      assert.equal(d.kind, 'halt');
    });

    it('does not halt below the limit', () => {
      assert.deepEqual(decide(snap({ cycleCount: 4 }), 101, { maxCycles: 5 }), {
        kind: 'cycle',
        reason: 'right-oor',
      });
    });

    it('never halts when the limit is disabled (0)', () => {
      assert.deepEqual(decide(snap({ cycleCount: 10_000 }), 101, { maxCycles: 0 }), {
        kind: 'cycle',
        reason: 'right-oor',
      });
    });

    it('takes precedence over an otherwise-actionable decision', () => {
      // A halt must win even when the price says "rebalance".
      assert.equal(decide(snap({ cycleCount: 3 }), 99, { maxCycles: 3 }).kind, 'halt');
    });
  });

  it('singleBinRange collapses to one bin', () => {
    assert.deepEqual(singleBinRange(42), { minBinId: 42, maxBinId: 42 });
  });
});
