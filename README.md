# 🌊 Meteora Bin Hunter

Private Telegram bot for fast Meteora DLMM liquidity management on Solana. Built for hit-and-run LP strategies.

## Features

- Auto LP — paste pool link directly in chat, instantly adds liquidity using active preset
- Extreme Mode — 1-bin BidAsk strategy with auto-rebalance every 2.5 seconds for maximum fee collection
- Multi-wallet — import and switch wallets via Telegram. PKs stored securely in .env, never in data.json
- Strategy Presets — save named presets with SOL amount (max for 99% balance), range%, and strategy
- Multi-strat input — add multiple presets at once, one per line
- Edit and Delete Strat — manage presets directly from Telegram
- Fast Remove — skipPreflight + parallel transactions for speed
- Sync Positions — detect positions opened manually on Meteora, auto-remove closed ones
- Auto Best RPC — pings configured RPCs on startup, uses fastest one
- All-button UI — everything via inline buttons, no manual commands needed

## Security

- Private keys in .env only (chmod 600), never in data.json
- data.json contains no sensitive data (only wallet metadata and presets)
- .env and data.json are gitignored

## Requirements

- Node.js v20+
- Telegram bot token from @BotFather
- Helius or other Solana RPC API key (optional but recommended)

## Installation

```bash
git clone https://github.com/dotnaonweh/meteora-bin-hunter.git
cd meteora-bin-hunter
npm install @meteora-ag/dlmm @solana/web3.js @solana/spl-token bn.js bs58
```

## Configuration

Create .env file:

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

Edit RPC list in meteorabot.js with your endpoints.

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

Note: Bot reads all config from .env automatically. No need to pass env vars manually.

## Usage

Send /start to your bot. Everything is button-based.

### Auto Mode

Paste a Meteora pool link directly in chat to instantly add LP using active preset.

### Strategy Presets

Add via Strategy menu. Single or multi-line:

```
SETORANBA max 7 bidask
SAFE 1 30 spot
```

Format: name sol|max range% spot|curve|bidask

Using max as SOL amount automatically uses 99% of wallet balance (reserves 0.08 SOL for fees).

### Extreme Mode

1-bin BidAsk with auto-rebalance every 2.5 seconds:

1. Opens 1-bin BidAsk position at current active bin
2. Price moves left (OOR) — withdraw tokens, re-add to same bin, wait
3. Price returns right — tokens convert to SOL, close + reopen fresh position
4. Repeats until you click Stop

### Wallet Management

Import wallets via Telegram. PKs saved to .env automatically as WALLET_1, WALLET_2, etc.

Always delete messages containing private keys after sending.

### Sync Positions

Detects positions opened manually on Meteora website. Auto-removes positions closed on-chain.

## License

MIT
