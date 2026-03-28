# 🌊 Meteora Bin Hunter

Private Telegram bot for fast Meteora DLMM liquidity management on Solana. Built for hit-and-run LP strategies.

## Features

- **Auto LP** — paste pool link directly in chat, instantly adds liquidity using active preset
- **Extreme Mode** — 1-bin BidAsk strategy with auto-rebalance every 2.5 seconds for maximum fee collection
- **Multi-wallet** — import and switch wallets via Telegram. PKs stored securely in `.env`, never in `data.json`. Messages containing PKs are auto-deleted immediately after import
- **Strategy Presets** — save named presets with SOL amount (or `max` for 99% balance), range%, and strategy
- **Multi-strat input** — add multiple presets at once, one per line
- **Edit and Delete Strat** — manage presets directly from Telegram
- **Delete Wallet** — remove wallets with confirmation prompt; PK wiped from `.env`
- **Fast Remove** — `skipPreflight` + parallel transactions for speed
- **Sync Positions** — detect positions opened manually on Meteora, auto-remove closed ones
- **Auto Best RPC** — pings configured RPCs on startup, uses fastest one
- **All-button UI** — everything via inline buttons, no manual commands needed

## Security

- Private keys in `.env` only (`chmod 600`), never in `data.json`
- `data.json` contains no sensitive data (only wallet metadata and presets)
- `.env` and `data.json` are gitignored
- Bot auto-deletes messages containing private keys immediately after import
- Input validation prevents accidentally saving a PK as a wallet name

## Requirements

- Node.js v20+
- Telegram bot token from @BotFather
- Helius or other Solana RPC API key (optional but recommended)

## Installation

```bash
git clone https://github.com/dotnaonweh/meteora-bin-hunter.git
cd meteora-bin-hunter
npm install
```

## Configuration

Create `.env` file:

```
TELEGRAM_TOKEN=your_telegram_bot_token
HELIUS_API_KEY=your_helius_api_key
WALLET_1=your_base58_private_key
WALLET_2=your_second_wallet_key
```

Secure it:

```bash
chmod 600 .env
```

Edit the RPC list in `meteorabot.js` with your endpoints if needed. Helius API key is auto-injected from `.env`.

## Running

With PM2 (recommended):

```bash
npm install -g pm2
pm2 start meteorabot.js --name meteorabot
pm2 save
pm2 startup
```

Direct:

```bash
node meteorabot.js
```

Wallets defined in `.env` as `WALLET_1`, `WALLET_2`, etc. are automatically loaded on startup — no manual import needed.

## Usage

Send `/start` to your bot. Everything is button-based.

### Auto Mode

Paste a Meteora pool link directly in chat to instantly add LP using the active preset.

```
https://app.meteora.ag/dlmm/<pool_address>
```

### Strategy Presets

Add via the Strategy menu. Single or multi-line:

```
SETORANBA max 7 bidask
SAFE 1 30 spot
```

Format: `name sol|max range% spot|curve|bidask`

Using `max` as SOL amount automatically uses 99% of wallet balance (reserves 0.08 SOL for fees).

### Extreme Mode

> ⚠️ **EXPERIMENTAL** — Use at your own risk. This mode executes on-chain transactions automatically and continuously. Bugs, network issues, or rapid price movement may result in loss of funds.

1-bin BidAsk with auto-rebalance every 2.5 seconds:

1. Opens 1-bin BidAsk position at current active bin
2. Price moves left (OOR) — withdraw tokens, re-add to same bin, wait
3. Price returns right — tokens convert to SOL, close + reopen fresh position
4. Repeats until you click Stop

If no preset is set, Extreme Mode offers a **MAX SOL** quick-start option directly.

### Wallet Management

Import wallets via Telegram. PKs saved to `.env` automatically as `WALLET_1`, `WALLET_2`, etc.

- Bot **automatically deletes** messages containing private keys after sending
- Use the 🗑️ button next to each wallet to remove it (with confirmation)

### Sync Positions

Detects positions opened manually on Meteora website. Auto-removes positions closed on-chain.

## License

MIT
