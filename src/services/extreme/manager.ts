import { recoverable } from '../../core/errors.js';
import type { Logger } from '../../observability/logger.js';
import type { Metrics } from '../../observability/metrics.js';
import { ExtremeSession, type ExtremeSessionDeps, type ExtremeSessionParams } from './session.js';

/**
 * Owns the lifecycle of every Extreme Mode session.
 *
 * Sessions are keyed by owner chat id. Starting a second session for a chat that
 * already has one is rejected rather than silently overwriting the handle — the
 * original overwrote `extremeSessions[chatId]`, orphaning the previous session's
 * timer *and* its on-chain position.
 */
export class ExtremeManager {
  private readonly sessions = new Map<string, ExtremeSession>();
  private readonly log: Logger;

  constructor(
    private readonly deps: ExtremeSessionDeps,
    logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.log = logger.child({ module: 'extreme-manager' });
  }

  get active(): ReadonlyMap<string, ExtremeSession> {
    return this.sessions;
  }

  has(id: string): boolean {
    return this.sessions.get(id)?.isRunning ?? false;
  }

  get(id: string): ExtremeSession | undefined {
    return this.sessions.get(id);
  }

  async start(params: ExtremeSessionParams): Promise<ExtremeSession> {
    const existing = this.sessions.get(params.id);
    if (existing?.isRunning) {
      throw recoverable('extreme.alreadyRunning', 'An Extreme session is already running. Stop it first.');
    }

    const session = new ExtremeSession(params, this.deps);
    this.sessions.set(params.id, session);

    try {
      await session.start();
    } catch (e) {
      // Never leave a half-started session in the map.
      this.sessions.delete(params.id);
      await session.stop().catch(() => {});
      throw e;
    }

    this.metrics.gauge('extreme.activeSessions', this.runningCount());
    return session;
  }

  async stop(id: string): Promise<number> {
    const session = this.sessions.get(id);
    if (!session) return 0;

    const cycles = session.snapshot.cycleCount;
    await session.stop();
    this.sessions.delete(id);
    this.metrics.gauge('extreme.activeSessions', this.runningCount());
    return cycles;
  }

  private runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.isRunning) n++;
    return n;
  }

  /** Stops every session. Used on graceful shutdown. */
  async stopAll(): Promise<void> {
    this.log.info('stopping all extreme sessions', { count: this.sessions.size });
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
