/**
 * Zero-dependency metrics registry.
 *
 * Counters and gauges are plain numbers. Histograms keep a fixed-size ring
 * buffer rather than an unbounded array, so a process running for months has a
 * bounded metrics footprint (the original had no metrics at all, but the
 * obvious naive implementation — push every sample into an array — is a slow
 * memory leak).
 */

const HISTOGRAM_WINDOW = 512;

class Histogram {
  private readonly samples = new Float64Array(HISTOGRAM_WINDOW);
  private cursor = 0;
  private filled = 0;
  private total = 0;
  private count = 0;

  observe(value: number): void {
    this.samples[this.cursor] = value;
    this.cursor = (this.cursor + 1) % HISTOGRAM_WINDOW;
    if (this.filled < HISTOGRAM_WINDOW) this.filled++;
    this.total += value;
    this.count++;
  }

  snapshot(): HistogramSnapshot {
    if (this.filled === 0) {
      return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    // Copy only the populated window, then sort in place.
    const window = this.samples.slice(0, this.filled);
    window.sort();
    return {
      count: this.count,
      mean: this.total / this.count,
      p50: quantile(window, 0.5),
      p95: quantile(window, 0.95),
      p99: quantile(window, 0.99),
      max: window[window.length - 1] ?? 0,
    };
  }
}

function quantile(sorted: Float64Array, q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, HistogramSnapshot>>;
  readonly process: {
    readonly rssMb: number;
    readonly heapUsedMb: number;
    readonly heapTotalMb: number;
    readonly uptimeSec: number;
    readonly cpuUserSec: number;
    readonly cpuSystemSec: number;
  };
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, valueMs: number): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    h.observe(valueMs);
  }

  /** Times `fn`, recording duration under `name` and a `${name}.errors` counter. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } catch (e) {
      this.increment(`${name}.errors`);
      throw e;
    } finally {
      this.observe(name, performance.now() - started);
    }
  }

  /**
   * Cache hit ratio helper. Call with `true` on hit, `false` on miss; the ratio
   * is derived at snapshot time rather than recomputed on every access.
   */
  cache(name: string, hit: boolean): void {
    this.increment(hit ? `cache.${name}.hits` : `cache.${name}.misses`);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;

    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;

    // Derive cache hit ratios so dashboards do not have to.
    for (const key of Object.keys(counters)) {
      if (!key.endsWith('.hits')) continue;
      const base = key.slice(0, -'.hits'.length);
      const hits = counters[key] ?? 0;
      const misses = counters[`${base}.misses`] ?? 0;
      const total = hits + misses;
      if (total > 0) gauges[`${base}.hitRatio`] = hits / total;
    }

    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [k, v] of this.histograms) histograms[k] = v.snapshot();

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const MB = 1024 * 1024;

    return {
      counters,
      gauges,
      histograms,
      process: {
        rssMb: mem.rss / MB,
        heapUsedMb: mem.heapUsed / MB,
        heapTotalMb: mem.heapTotal / MB,
        uptimeSec: process.uptime(),
        cpuUserSec: cpu.user / 1e6,
        cpuSystemSec: cpu.system / 1e6,
      },
    };
  }
}
