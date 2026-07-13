# 🌊 Meteora Bin Hunter

Telegram-driven liquidity bot for [Meteora DLMM](https://app.meteora.ag/) on Solana. Built for fast, hands-on LP management from your phone: paste a pool link, get a position.

**v2 is a full rewrite** — layered TypeScript, websocket-driven rebalancing, and a security model that actually exists. See [What changed in v2](#what-changed-in-v2).

> [!WARNING]
> This bot signs transactions with a hot wallet, automatically. Extreme Mode trades continuously without asking. Bugs, network failures, or fast price movement can lose funds. Run it with money you can afford to lose.

---

## What it does

| Feature | Description |
|---|---|
| **Auto LP** | Paste a pool link in chat → position opened with your active preset |
| **Extreme Mode** | 1-bin BidAsk position, auto-rebalanced as the active bin moves |
| **Presets** | Named strategies: SOL amount (fixed / `50%` / `max`), range %, and shape |
| **Multi-wallet** | Import and switch wallets from Telegram; keys live only in `.env` |
| **Sync** | Adopts positions opened on the Meteora website, drops closed ones |
| **RPC failover** | Endpoints continuously scored; degraded ones are bypassed automatically |
| **Stats** | Live RPC/tx latency, cache hit ratios, cycle counts, memory |

## Security model

Read this before running it.

- **The bot only obeys `TELEGRAM_OWNER_IDS`.** It refuses to start without an allowlist. Anyone can message a Telegram bot whose @username they know — v1 had no authorization check at all, so a stranger who found it could spend the owner's wallet.
- **Private keys live only in `.env`** (`chmod 600`), never in `data.json`. `.env` is rewritten atomically, and comments are preserved.
- **Messages containing a private key are deleted before anything else happens** — including when the key is invalid, and including when an unauthorized user sends one.
- **A pasted address is verified to be a real DLMM pool** (owner check against the DLMM program) before any funds are sent to it.
- **`data.json` holds no secrets.** A wallet name that looks like a base58 key is scrubbed before it can be written.

Both `.env` and `data.json` are gitignored.

## Requirements

- Node.js 20+
- A Telegram bot token ([@BotFather](https://t.me/botfather))
- Your numeric chat ID ([@userinfobot](https://t.me/userinfobot))
- A Solana RPC endpoint — Helius or similar strongly recommended over the public one

## Install

```bash
git clone https://github.com/dotnaonweh/meteora-bin-hunter.git
cd meteora-bin-hunter
npm install
npm run build

cp .env.example .env
chmod 600 .env
$EDITOR .env          # set TELEGRAM_TOKEN and TELEGRAM_OWNER_IDS
```

## Run

```bash
npm start                      # production
npm run dev                    # watch mode, pretty logs
```

With PM2:

```bash
pm2 start dist/index.js --name meteora-bin-hunter
pm2 save && pm2 startup
```

## Usage

Send `/start`. Everything is buttons.

**Presets** — `<name> <sol|max|50%> <range%> <spot|curve|bidask>`, one per line:

```
SCALP max 7 bidask
SAFE  1   30 spot
HALF  50% 5  bidask
```

`max` uses your whole balance minus the fee reserve (default 0.08 SOL). `50%` uses half of what's usable.

**Auto LP** — paste a pool link, and the active preset is applied:

```
https://app.meteora.ag/dlmm/<pool_address>
```

**Extreme Mode** — opens a 1-bin BidAsk position at the active bin, then:

1. Price moves **below** the bin → withdraw the token, re-add it to the same bin, wait.
2. Price comes **back** → close, and reopen fresh at the new active bin.
3. Price moves **above** the bin → close, and reopen fresh at the new active bin.

It repeats until you press Stop. Stop cancels in-flight work; it does not close the position, so remove it from **Positions** if you want out.

---

## Architecture

Business logic never talks to the network directly; infrastructure never knows what a preset is. Dependencies point inward, and there are no cycles.

```
src/
├── index.ts              Composition root — the only place concretes are wired
│
├── config/               Env parsing, validation, defaults. No hardcoded values.
├── constants/            Mints, program IDs, enums
├── types/                Domain + Telegram types
│
├── core/                 errors (severity classification), lifecycle (graceful shutdown)
│
├── net/                  http (keep-alive pool, retry, dedupe), retry (jittered backoff),
│                         circuit-breaker, rate-limiter
│
├── providers/rpc/        endpoint-pool (scoring + failover), subscriptions (websocket
│                         account watching), lbpair-decoder (raw account → activeId)
│
├── adapters/             ── infrastructure ──
│   ├── dlmm/             pool-cache, tx (priority fees, idempotent confirm), client
│   ├── meteora/          pnl (cached PnL API)
│   └── telegram/         api, auth, poller, router, ui (pure renderers)
│
├── services/             ── business logic, no I/O primitives ──
│   ├── liquidity.ts      add / remove LP
│   ├── positions.ts      status, chain reconciliation
│   └── extreme/          machine.ts (PURE decision fn) · session.ts · manager.ts
│
├── state/                store (atomic writes), wallets, presets, positions
└── observability/        logger (structured), metrics (counters/gauges/histograms)
```

### Execution flow

```
                    ┌──────────────── Telegram long-poll ────────────────┐
                    │  poller → auth gate → router → service → adapter   │
                    └───────────────────────────────────────────────────┘
                                            │
   startup ─→ config (validate, else exit) ─┤
              ↓                             │
              RPC pool (score all, pick fastest, keep scoring)
              ↓                             │
              state (load data.json, import WALLET_n from env)
                                            │
   Extreme ─→ websocket sub on LbPair ─→ decode activeId (43µs, 0 RPC)
              ↓                             │
              suppress if bin unchanged ────┤   ← most swaps don't move the bin
              ↓                             │
              pure decide(phase, bin) ─→ idle | rebalance | cycle | halt
              ↓
              serialised execution, abortable at every await
```

### The core design decisions

**The active bin arrives over a websocket, not a poll.** v1 called `DLMM.create()` + `getActiveBin()` every 2.5 seconds to read one integer. v2 subscribes to the pool's `LbPair` account and decodes `activeId` straight out of the pushed buffer — **43µs of CPU and zero RPC calls**, verified against mainnet to match the SDK exactly. The 2.5s timer survives only as a fallback for when the socket goes quiet.

**The pool object is built once.** v1 reconstructed the same `DLMM` pool 4–6 times per rebalance cycle. v2 caches it, refreshes only when a push marks it dirty or it ages out, and collapses concurrent construction of the same pool into a single request (50 concurrent cold reads → 2 RPC calls).

**The strategy is a pure function.** `services/extreme/machine.ts` is `decide(state, currentBin) → action` — no clock, no chain, no socket. Every branch of the original's rebalance logic is asserted in `tests/machine.test.ts`, so a future change cannot silently alter how the bot trades.

**Failures are classified, not guessed at.** Every error is `retryable`, `recoverable`, or `fatal`. Retries only ever fire on `retryable` — retrying a rejected input just burns rate-limit budget. Anything unrecognised defaults to `recoverable` rather than being hammered.

**Cancellation is real.** Every await in a session is threaded with an `AbortSignal`, and `stop()` waits for in-flight work to unwind. In v1, pressing Stop during a cycle could still open a brand-new position *after* you stopped.

## Configuration

Every value is an environment variable with a validated default — see [`.env.example`](.env.example). Config errors fail at startup with a plain message, not a stack trace.

The two that matter most:

| Variable | Why |
|---|---|
| `TELEGRAM_OWNER_IDS` | **Required.** Without it, anyone could spend your wallet. |
| `TX_PRIORITY_FEE_MICROLAMPORTS` | v1 sent **zero** priority fee, so its transactions lost the race for blockspace. Default `50000`; raise it when the network is busy. |

Also worth knowing: `EXTREME_MIN_EVAL_INTERVAL_MS` defaults to `2500`, which reproduces v1's cadence exactly. Set it to `0` to let the websocket drive rebalances at slot latency — faster, but it changes how often you trade.

## Observability

Structured logs (`pretty` in dev, JSON lines in prod) with module names, durations, and RPC latency. Secrets are redacted at the logger, whatever a caller passes.

Metrics are on the **📈 Stats** button and logged periodically: RPC/tx latency percentiles, pools cached, bin changes vs. suppressed pushes, websocket reconnects, cache hit ratios, cycles, errors, memory, and rejected unauthorized requests.

## Tests

```bash
npm test        # 58 tests, no network required
```

Covers the rebalance decision machine exhaustively (including the deliberate `>` vs `>=` asymmetry carried over from v1), preset/pool-address parsing, sizing arithmetic, error classification, the circuit breaker, the rate limiter, and metrics.

The pool-address parser has explicit regression tests for v1's habit of taking the **last** base58-looking token in a message — which let trailing text redirect where funds went.

---

## What changed in v2

v1 was a single 969-line JavaScript file. Same features, rebuilt.

**Security**
- Added the authorization allowlist. v1 accepted commands from **any** Telegram user.
- Pasted addresses are verified to be DLMM pools before funds move.
- Pool-address extraction no longer takes the last match in a message.
- Key-bearing messages are deleted before any fallible work runs.
- One user can no longer stop another's Extreme session.

**Correctness**
- Stop now cancels in-flight work instead of letting it open an orphan position.
- Transactions carry priority fees and a slippage bound; v1 had neither.
- A confirmation timeout re-checks whether the tx actually landed, instead of assuming failure and double-opening.
- `data.json` is written atomically; a crash mid-write no longer corrupts it.
- Removing a `WALLET_n` no longer silently erases the wallets numbered after it.

**Performance**
- Websocket-driven bins: ~1 RPC per *bin change* instead of ~2 every 2.5s per session, forever.
- Pool objects cached: 4–6 constructions per cycle → 0 on the hot path.
- Keep-alive connection pooling; v1 opened a fresh TLS connection per Telegram and PnL call.
- Keypairs decoded once, not on every `getActiveWallet()` call.
- State writes coalesced and off the synchronous deep-clone path.

**Removed**
- `discord.js` and `@solana/spl-token` — both were dependencies with zero imports.
- `closeAndReopenPosition()` (65 lines, never called), the unread `chatIds` set, the unreachable empty-wallet branch, and the dead `'oor'` state.
- The remove-liquidity block that appeared 4×, the position lookup that appeared 3×, and the preset label that was reimplemented 4×.

## License

MIT
