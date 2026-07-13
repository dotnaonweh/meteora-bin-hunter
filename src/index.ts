import { DlmmClient } from './adapters/dlmm/client.js';
import { PoolCache } from './adapters/dlmm/pool-cache.js';
import { TxSender } from './adapters/dlmm/tx.js';
import { PnlClient } from './adapters/meteora/pnl.js';
import { TelegramApi } from './adapters/telegram/api.js';
import { AuthGate } from './adapters/telegram/auth.js';
import { TelegramPoller } from './adapters/telegram/poller.js';
import { Router } from './adapters/telegram/router.js';
import { loadConfig, loadEnvFile } from './config/index.js';
import { classify, isAppError } from './core/errors.js';
import { Lifecycle } from './core/lifecycle.js';
import { HttpClient } from './net/http.js';
import { createLogger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { RpcPool } from './providers/rpc/endpoint-pool.js';
import { decoderAvailable } from './providers/rpc/lbpair-decoder.js';
import { SubscriptionManager } from './providers/rpc/subscriptions.js';
import { ExtremeManager } from './services/extreme/manager.js';
import { LiquidityService } from './services/liquidity.js';
import { PositionService } from './services/positions.js';
import { PositionRegistry } from './state/positions.js';
import { PresetRegistry } from './state/presets.js';
import { StateStore } from './state/store.js';
import { WalletRegistry } from './state/wallets.js';

/**
 * Composition root. The only place where concrete implementations are wired
 * together; every other module depends on interfaces and constructor arguments,
 * which is what makes them individually testable.
 */
async function main(): Promise<void> {
  loadEnvFile(process.env.ENV_FILE ?? './.env');

  const cfg = loadConfig();

  const logger = createLogger({
    level: cfg.observability.logLevel,
    format: cfg.observability.logFormat,
  });
  const metrics = new Metrics();
  const lifecycle = new Lifecycle(logger);
  lifecycle.install();

  const log = logger.child({ module: 'main' });
  log.info('starting meteora-bin-hunter', {
    endpoints: cfg.rpc.endpoints.map((e) => e.label).join(','),
    owners: cfg.telegram.ownerChatIds.size,
    priorityFee: cfg.tx.priorityFeeMicroLamports,
  });

  if (!decoderAvailable()) {
    // Not fatal, but the websocket fast path is unavailable and everything will
    // fall back to polling. The operator needs to know.
    log.warn('LbPair decoder unavailable; extreme mode will fall back to polling');
  }

  // --- infrastructure ---------------------------------------------------
  const http = new HttpClient({
    connections: cfg.http.connections,
    timeoutMs: cfg.http.timeoutMs,
    maxRetries: cfg.http.maxRetries,
    logger,
    metrics,
  });

  const rpc = new RpcPool(cfg, logger, metrics);
  await rpc.healthCheck();
  rpc.startHealthChecks();
  log.info('rpc ready', { primary: rpc.primaryLabel });

  const subscriptions = new SubscriptionManager(rpc, logger, metrics);
  subscriptions.startHeartbeat();

  // --- state ------------------------------------------------------------
  const store = new StateStore(cfg.state.dataFile, cfg.state.flushIntervalMs, logger);
  const wallets = new WalletRegistry(store, cfg.state.envFile, logger);
  wallets.bootstrapFromEnv();
  const presets = new PresetRegistry(store);
  const positions = new PositionRegistry(store);

  const activeWallet = wallets.activeMeta;
  if (activeWallet) log.info('active wallet', { name: activeWallet.name, pubkey: activeWallet.pubkey });
  else log.warn('no wallet configured — import one via Telegram');

  // --- adapters & services ----------------------------------------------
  const pools = new PoolCache(rpc, logger, metrics);
  pools.startEviction();

  const tx = new TxSender(rpc, cfg, logger, metrics);
  const dlmm = new DlmmClient(pools, tx, rpc, cfg, logger, metrics);
  const pnl = new PnlClient(http, logger, metrics);

  const liquidity = new LiquidityService(dlmm, pools, wallets, positions, rpc, cfg, logger, metrics);
  const positionsService = new PositionService(dlmm, pnl, wallets, positions, logger);
  const extreme = new ExtremeManager({ dlmm, pools, subscriptions, cfg, logger, metrics }, logger, metrics);

  // --- telegram ---------------------------------------------------------
  const api = new TelegramApi(cfg.telegram.token, http, logger, cfg.telegram.pollTimeoutSec);
  const auth = new AuthGate(cfg.telegram.ownerChatIds, logger, metrics);

  const router = new Router({
    api,
    auth,
    dlmm,
    liquidity,
    positionsService,
    extreme,
    wallets,
    presets,
    positions,
    rpc,
    cfg,
    logger,
    metrics,
  });

  const poller = new TelegramPoller(api, router, logger, metrics);
  poller.start();

  // --- periodic metrics -------------------------------------------------
  if (cfg.observability.metricsIntervalMs > 0) {
    const metricsTimer = setInterval(() => {
      const snap = metrics.snapshot();
      logger.child({ module: 'metrics' }).info('metrics', {
        rssMb: Math.round(snap.process.rssMb),
        heapMb: Math.round(snap.process.heapUsedMb),
        rpcCalls: snap.counters['rpc.calls'] ?? 0,
        rpcErrors: snap.counters['rpc.errors'] ?? 0,
        rpcP95: Math.round(snap.histograms['rpc.latency']?.p95 ?? 0),
        wsBinChanges: snap.counters['ws.binChanges'] ?? 0,
        wsSuppressed: snap.counters['ws.suppressed'] ?? 0,
        txConfirmed: snap.counters['tx.confirmed'] ?? 0,
        poolCacheHitRatio: Number((snap.gauges['cache.pool.hitRatio'] ?? 0).toFixed(3)),
        extremeSessions: snap.gauges['extreme.activeSessions'] ?? 0,
        pools: pools.size,
      });
    }, cfg.observability.metricsIntervalMs);
    metricsTimer.unref();
    lifecycle.onShutdown('metrics', () => clearInterval(metricsTimer));
  }

  // --- shutdown (LIFO) --------------------------------------------------
  lifecycle.onShutdown('state', () => store.close());
  lifecycle.onShutdown('http', () => http.close());
  lifecycle.onShutdown('rpc', () => rpc.close());
  lifecycle.onShutdown('pools', () => pools.close());
  lifecycle.onShutdown('subscriptions', () => subscriptions.close());
  lifecycle.onShutdown('extreme', () => extreme.stopAll());
  lifecycle.onShutdown('telegram', () => poller.stop());

  log.info('ready');
}

main().catch((e: unknown) => {
  const err = classify(e);
  // Config errors are the common startup failure; print them plainly rather
  // than burying the reason in a stack trace.
  if (isAppError(err) && err.severity === 'fatal') {
    process.stderr.write(`\n❌ ${err.message}\n\n`);
  } else {
    process.stderr.write(`\n❌ Startup failed: ${err.message}\n${e instanceof Error ? (e.stack ?? '') : ''}\n`);
  }
  process.exit(1);
});
