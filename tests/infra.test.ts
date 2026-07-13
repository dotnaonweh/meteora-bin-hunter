import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircuitBreaker } from '../src/net/circuit-breaker.js';
import { RateLimiter } from '../src/net/rate-limiter.js';
import { backoffDelay } from '../src/net/retry.js';
import { classify, fatal, recoverable, retryable } from '../src/core/errors.js';
import { Metrics } from '../src/observability/metrics.js';

describe('error classification', () => {
  it('keeps an explicit severity', () => {
    assert.equal(classify(retryable('x', 'boom')).severity, 'retryable');
    assert.equal(classify(recoverable('x', 'boom')).severity, 'recoverable');
    assert.equal(classify(fatal('x', 'boom')).severity, 'fatal');
  });

  it('classifies socket errors as retryable', () => {
    const e = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    assert.equal(classify(e).severity, 'retryable');
  });

  it('classifies 429 and 5xx as retryable', () => {
    assert.equal(classify(Object.assign(new Error('rate'), { status: 429 })).severity, 'retryable');
    assert.equal(classify(Object.assign(new Error('boom'), { status: 503 })).severity, 'retryable');
  });

  it('classifies Solana blockhash expiry as retryable', () => {
    assert.equal(classify(new Error('Blockhash not found')).severity, 'retryable');
    assert.equal(classify(new Error('block height exceeded')).severity, 'retryable');
  });

  it('defaults unknown failures to recoverable, NOT retryable', () => {
    // Retrying an unrecognised failure would hammer an endpoint that is
    // rejecting us for a real reason.
    assert.equal(classify(new Error('some business rule failed')).severity, 'recoverable');
    assert.equal(classify(Object.assign(new Error('bad req'), { status: 400 })).severity, 'recoverable');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and stays within the cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = backoffDelay(attempt, 100, 5_000);
        assert.ok(d >= 0, 'never negative');
        assert.ok(d <= 5_000, 'never exceeds the cap');
      }
    }
  });

  it('uses full jitter (values vary across calls)', () => {
    const values = new Set(Array.from({ length: 40 }, () => backoffDelay(5, 100, 5_000)));
    assert.ok(values.size > 1, 'jitter should produce varying delays');
  });
});

describe('CircuitBreaker', () => {
  const opts = { name: 't', failureThreshold: 3, resetTimeoutMs: 1_000, successThreshold: 2 };

  it('opens after consecutive failures', () => {
    const cb = new CircuitBreaker(opts);
    assert.equal(cb.current, 'closed');
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.current, 'closed');
    cb.recordFailure();
    assert.equal(cb.current, 'open');
    assert.equal(cb.canAttempt(), false);
  });

  it('a success resets the failure streak', () => {
    const cb = new CircuitBreaker(opts);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.current, 'closed', 'streak was broken, so it should not have opened');
  });

  it('moves to half-open after the reset timeout, then closes on enough successes', () => {
    const cb = new CircuitBreaker(opts);
    const t0 = 10_000;
    cb.recordFailure(t0);
    cb.recordFailure(t0);
    cb.recordFailure(t0);
    assert.equal(cb.current, 'open');

    assert.equal(cb.canAttempt(t0 + 999), false, 'still open before the timeout');
    assert.equal(cb.canAttempt(t0 + 1_001), true, 'probe allowed after the timeout');
    assert.equal(cb.current, 'half-open');

    cb.recordSuccess();
    assert.equal(cb.current, 'half-open');
    cb.recordSuccess();
    assert.equal(cb.current, 'closed');
  });

  it('a failure while half-open re-opens immediately', () => {
    const cb = new CircuitBreaker(opts);
    const t0 = 10_000;
    cb.recordFailure(t0);
    cb.recordFailure(t0);
    cb.recordFailure(t0);
    cb.canAttempt(t0 + 2_000); // -> half-open
    assert.equal(cb.current, 'half-open');
    cb.recordFailure(t0 + 2_000);
    assert.equal(cb.current, 'open');
  });
});

describe('RateLimiter', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const rl = new RateLimiter(3, 1, 0);
    assert.equal(rl.tryAcquire(0), true);
    assert.equal(rl.tryAcquire(0), true);
    assert.equal(rl.tryAcquire(0), true);
    assert.equal(rl.tryAcquire(0), false, 'bucket is empty');
  });

  it('refills over time at the configured rate', () => {
    const rl = new RateLimiter(2, 10, 0); // 10 tokens/sec
    assert.equal(rl.tryAcquire(0), true);
    assert.equal(rl.tryAcquire(0), true);
    assert.equal(rl.tryAcquire(0), false);
    // 100ms later exactly one token has regenerated.
    assert.equal(rl.tryAcquire(100), true);
    assert.equal(rl.tryAcquire(100), false);
  });

  it('never exceeds capacity no matter how long it idles', () => {
    const rl = new RateLimiter(2, 10, 0);
    for (let i = 0; i < 2; i++) assert.equal(rl.tryAcquire(1_000_000), true);
    assert.equal(rl.tryAcquire(1_000_000), false, 'capped at capacity, not unbounded');
  });
});

describe('Metrics', () => {
  it('derives cache hit ratios', () => {
    const m = new Metrics();
    m.cache('pool', true);
    m.cache('pool', true);
    m.cache('pool', true);
    m.cache('pool', false);
    assert.equal(m.snapshot().gauges['cache.pool.hitRatio'], 0.75);
  });

  it('computes histogram quantiles', () => {
    const m = new Metrics();
    for (let i = 1; i <= 100; i++) m.observe('lat', i);
    const h = m.snapshot().histograms['lat']!;
    assert.equal(h.count, 100);
    assert.equal(h.max, 100);
    assert.ok(h.p50 >= 49 && h.p50 <= 51, `p50 was ${h.p50}`);
    assert.ok(h.p95 >= 94 && h.p95 <= 96, `p95 was ${h.p95}`);
  });

  it('bounds histogram memory with a ring buffer', () => {
    const m = new Metrics();
    // Far more samples than the window; must not grow without bound.
    for (let i = 0; i < 10_000; i++) m.observe('lat', i);
    const h = m.snapshot().histograms['lat']!;
    assert.equal(h.count, 10_000, 'total count is still tracked');
    assert.ok(h.p50 > 9_000, 'quantiles reflect the recent window, not the whole history');
  });
});
