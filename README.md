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

## Requirements

- Node.js v20+
- Telegram bot token from @BotFather

## Installation
```bash
git clone https://github.com/dotnaonweh/meteora-bin-hunter.git
cd meteora-bin-hunter
npm install @meteora-ag/dlmm @solana/web3.js @solana/spl-token bn.js bs58
```

## Configuration

1. Create .env file with your wallet private keys:
```
WALLET_1=YOUR_BASE58_PRIVATE_KEY
WALLET_2=YOUR_SECOND_WALLET_KEY
```

Secure it:
```bash
chmod 600 .env
```

2. Edit RPC list in meteorabot.js with your own endpoints.

## Running

With PM2:
```bash
npm install -g pm2
TELEGRAM_TOKEN=xxx pm2 start meteorabot.js --name meteorabot
pm2 save
pm2 startup
```

Direct:
```bash
TELEGRAM_TOKEN=xxx node meteorabot.js
```

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

### Extreme Mode
1-bin BidAsk with auto-rebalance every 2.5 seconds:
- Price moves left (OOR) — withdraw tokens, re-add to same bin, wait
- Price returns right — close + reopen fresh position
- Repeats until you click Stop

### Wallet Management
Import wallets via Telegram. PKs are saved to .env automatically (WALLET_1, WALLET_2, etc). Never stored in data.json.

Always delete messages containing private keys after sending.

### Sync Positions
Detects positions opened manually on Meteora. Auto-removes closed positions.

## Security

- Private keys in .env only (chmod 600)
- data.json contains no sensitive data
- .env and data.json are gitignored

## License

MIT
