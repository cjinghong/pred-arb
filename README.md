# pred-arb

Cross-platform prediction market arbitrage bot. Monitors [Polymarket](https://polymarket.com), [Kalshi](https://kalshi.com), and [predict.fun](https://predict.fun) for pricing discrepancies on equivalent markets, then executes simultaneous 2-legged trades to lock in risk-free profit.

## Screenshots

| | |
|---|---|
| ![Dashboard](screenshots/1.png) | ![Dashboard2](screenshots/2.png) |
| Matched Markets | Manual Match Markets |
| ![Opportunities](screenshots/3.png) | ![Trades](screenshots/4.png) |
Opportunities Tab | Trades tab |
| ![Positions](screenshots/5.png) | |
| View all positions across platforms | |


## How it works

Binary prediction markets settle at $1 (event happened) or $0 (it didn't). By buying YES on one platform and NO on another for the same event, the combined position pays out $1 regardless of the outcome. If both legs cost less than $1, the difference is guaranteed profit.

```
Polymarket:  "Will X happen?" — YES @ $0.48
Kalshi:      "Will X happen?" — NO  @ $0.49

Cost:   $0.48 + $0.49 = $0.97
Payout: $1.00 (guaranteed)
Profit: $0.03/share (≈ 3.1%)
```

The bot scans both directions (YES-A + NO-B and NO-A + YES-B) across all platform pairs, using WebSocket order book updates to detect opportunities instantly.

## Quick start

### Prerequisites

- **Node.js 18+** (20 LTS recommended)
- **Platform accounts** on at least 2 of: Polymarket, Kalshi, predict.fun
- **LLM** for non-sports market matching (optional — [Ollama](https://ollama.com) for free local inference, or an Anthropic API key)

### Install

```bash
git clone https://github.com/cjinghong/pred-arb.git
cd pred-arb
npm run setup        # installs backend + dashboard dependencies
cp .env.example .env
```

### Configure

Edit `.env` with your platform credentials. See `.env.example` for all options with descriptions.

The minimum you need to get started in dry-run mode (no real trades):

```env
# Pick your platforms (need at least 2)
ENABLED_PLATFORMS=polymarket,kalshi

# Polymarket — public key + private key for reading markets
POLYMARKET_PRIVATE_KEY=your_hex_private_key
POLYMARKET_PROXY_ADDRESS=0xYourProxyAddress

# Kalshi — API key + RSA private key for reading markets
KALSHI_API_KEY_ID=your_key_id
KALSHI_PRIVATE_KEY_PATH=./kalshi-key.pem

# Categories to scan
MARKET_CATEGORIES=sports,politics

# LLM for matching non-sports markets (optional)
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
```

> **No credentials?** The bot will still start and show the dashboard — connectors that fail to authenticate are skipped gracefully. You need at least 2 connected platforms for arbitrage detection.

### Run

```bash
# Development (hot-reload)
npm run dev                # bot + API on :3848
npm run dashboard:dev      # dashboard on :3847 (separate terminal)

# Production
npm run build:all          # compile everything
npm start                  # bot + API + dashboard on :3848
```

Open the dashboard at `http://localhost:3847` (dev) or `http://localhost:3848` (production).

## Architecture

```
Bot Orchestrator (bot.ts)
  ├── Connectors (3 platforms)
  │     ├── PolymarketConnector   ← CLOB SDK, EIP-712, USDC/Polygon
  │     ├── KalshiConnector       ← RSA-PSS auth, USD/cents
  │     └── PredictFunConnector   ← SDK + JWT, USDT/BNB
  │
  ├── Market Discovery (category-aware)
  │     ├── SportsDiscovery       ← platform-specific sports APIs
  │     └── Generic Discovery     ← paginated category fetching
  │
  ├── Market Matching
  │     ├── SportsMatcher         ← deterministic team+date matching (no LLM)
  │     ├── MarketMatcher         ← 5-pass pipeline: cross-ref → slug → fuzzy → LLM
  │     └── LLMVerifier           ← Anthropic / Ollama / OpenAI-compatible
  │
  ├── Strategy: CrossPlatformArb
  │     ├── Book walking          ← walks multiple price levels for optimal sizing
  │     ├── Fee-aware analysis    ← platform-specific fee deduction
  │     └── Dynamic thresholds    ← adjusts min profit by confidence/spread/depth
  │
  ├── ExecutionEngine             ← 2-legged simultaneous trades
  ├── RiskManager                 ← position limits, exposure caps, balance checks
  │
  └── API Server (Express + WebSocket)
        └── Dashboard (Next.js)   ← Bloomberg terminal-style UI
```

### N-platform pairwise design

With 3 platforms, the bot generates all unique pairs and runs matching independently on each:

- Polymarket ↔ Kalshi
- Polymarket ↔ predict.fun
- predict.fun ↔ Kalshi

Connector failures are non-fatal — the bot continues with whichever platforms connect (minimum 2 required).

### Category-aware discovery

Market discovery and matching are category-aware. Set `MARKET_CATEGORIES=sports,politics,crypto` to process each category sequentially — fetch from all platforms, match within the category, then move to the next. This avoids cross-category noise and wasted LLM calls.

**Sports** use a deterministic pipeline: platform-specific sports APIs → team name normalization (100+ alias entries) → match by `team1|team2::date::league` key. No LLM needed.

**Non-sports** (politics, crypto) use the generic 5-pass pipeline: cross-reference IDs → slug matching → fuzzy text → LLM batch-match. LLM matches require manual approval on the dashboard.

## Dashboard

The dashboard uses a retro Bloomberg terminal aesthetic — amber/green on black, monospace font, scanline overlay.

**Tabs:**

- **Opportunities** — live arb opportunities with profit, prices, status, and match confidence
- **Markets** — all fetched markets, matched pairs grouped by status, manual match UI
- **Trades** — execution history with leg details and P&L
- **Positions** — live positions from the risk manager

**Header controls:** PAUSE / RESUME / STOP / RESET

**Category chips:** toggle which categories to scan (sports, politics, crypto, etc.) with auto-refresh on change.

**Pair detail page:** click any matched pair to see side-by-side live order books with YES/NO toggle and inline arb analysis.

## Project structure

```
pred-arb/
├── src/
│   ├── connectors/           # Platform connectors (Polymarket, Kalshi, predict.fun)
│   ├── discovery/            # Category-aware market discovery
│   ├── matcher/              # Market matching (sports, generic, LLM)
│   ├── strategies/           # Arbitrage strategy
│   ├── engine/               # Bot orchestrator, execution, risk, API server
│   ├── db/                   # SQLite database
│   ├── utils/                # Config, logging, event bus, rate limiter
│   ├── scripts/              # Standalone test scripts per platform
│   └── index.ts              # Entry point
├── dashboard/                # Next.js frontend (static export)
├── docs/                     # Strategy documentation
├── .env.example              # Environment template
├── package.json
└── tsconfig.json
```

## Configuration reference

All configuration is via environment variables. See `.env.example` for the complete list.

**Key settings:**

| Variable | Default | Description |
|---|---|---|
| `ENABLED_PLATFORMS` | `polymarket,kalshi` | Comma-separated platforms to connect |
| `DRY_RUN` | `true` | Set to `false` for live trading |
| `MIN_PROFIT_BPS` | `150` | Minimum profit threshold (basis points) |
| `MAX_POSITION_USD` | `500` | Max USD per trade leg |
| `MAX_TOTAL_EXPOSURE_USD` | `5000` | Total exposure cap |
| `MARKET_CATEGORIES` | — | Categories to scan (e.g., `sports,politics`) |
| `LLM_PROVIDER` | `anthropic` | LLM for matching: `ollama`, `anthropic`, `openai` |

## Live trading

> **The bot starts in dry-run mode by default.** Set `DRY_RUN=false` only after reviewing simulated results.

**Recommended go-live sequence:**

1. Run in dry-run mode, review matched pairs and simulated opportunities
2. Set conservative limits: `MAX_POSITION_USD=10`, `MIN_PROFIT_BPS=200`
3. Set `DRY_RUN=false`, monitor for 24h
4. Gradually increase position sizes as confidence grows

**Platform requirements for live trading:**

- **Polymarket** — funded USDC wallet on Polygon, L2 API credentials (key/secret/passphrase), private key for EIP-712 signing
- **Kalshi** — API key ID + RSA-4096 private key uploaded to Kalshi settings
- **predict.fun** — API key (from Discord), Privy wallet private key, Smart Wallet address

**Fee schedule:**

| Platform | Maker | Taker |
|---|---|---|
| Polymarket | 0% | 0% |
| Kalshi | 0% | $0.07 × P × (1−P) per contract (min $0.02) |
| predict.fun | 0% | 2% × min(price, 1−price) × shares |

## Adding a new platform

Implement the `MarketConnector` interface in `src/connectors/`:

```typescript
export class MyPlatformConnector extends BaseConnector {
  readonly platform: Platform = 'myplatform';
  readonly name = 'My Platform';

  async connect(): Promise<void> { /* ... */ }
  async fetchMarkets(opts?: FetchMarketsOptions): Promise<NormalizedMarket[]> { /* ... */ }
  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> { /* ... */ }
  async placeOrder(order: OrderRequest): Promise<OrderResult> { /* ... */ }
  async cancelOrder(orderId: string): Promise<boolean> { /* ... */ }
  async getOpenOrders(): Promise<OrderResult[]> { /* ... */ }
  async getBalance(): Promise<number> { /* ... */ }
}
```

Then add `'myplatform'` to the `Platform` type in `src/types/market.ts` and register the connector in `src/engine/bot.ts`.

## Development

```bash
npm run dev              # hot-reload backend
npm run dashboard:dev    # hot-reload frontend
npm run typecheck        # TypeScript check (no emit)
npm test                 # run tests
npm run build:all        # compile everything
```

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | TypeScript, Node.js 18+ |
| Platforms | Polymarket (CLOB SDK), Kalshi (REST + RSA-PSS), predict.fun (SDK + JWT) |
| Matching | Deterministic (sports) + Fuse.js + LLM (Anthropic / Ollama) |
| Database | SQLite (better-sqlite3) |
| API | Express + WebSocket |
| Dashboard | Next.js 15 (React, static export) |
| Signing | ethers.js v6 (EIP-712, typed data) |

## License

MIT
