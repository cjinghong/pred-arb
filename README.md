# PRED-ARB

> Prediction market cross-platform arbitrage bot with a retro-futuristic Bloomberg terminal dashboard.

Continuously scans [Polymarket](https://polymarket.com) and [predict.fun](https://predict.fun) for equivalent markets trading at different prices. When the combined cost of holding both YES on one platform and NO on the other drops below $1.00, the bot surfaces the opportunity and (in live mode) executes both legs simultaneously.

---

## How it works

Binary prediction markets always settle at either $1.00 (outcome occurred) or $0.00 (it didn't). Because you can hold YES on one platform and NO on another for the same event, the combined position is guaranteed to pay out $1.00 regardless of the result. If you can buy both legs for less than $1.00, you have locked-in arbitrage profit.

```
Polymarket:   "Will X happen?" — YES ask at $0.48
predict.fun:  "Will X happen?" — NO  ask at $0.49

Cost:   $0.48 + $0.49 = $0.97
Payout: $1.00
Profit: $0.03 per share (≈ 309 basis points)
```

The strategy runs in both directions — YES on A + NO on B, and NO on A + YES on B — and checks both platforms' live order books every scan cycle.

---

## Features

- **Multi-platform architecture** — add new prediction markets by implementing a single `MarketConnector` interface
- **Extensible strategy engine** — swap in new strategies (e.g. multi-leg, hedged, statistical arb) by implementing the `Strategy` interface
- **Fuzzy market matching** — Fuse.js text similarity + slug/date/category heuristics to identify equivalent markets across platforms
- **Pre-trade risk checks** — position size limits, total exposure cap, per-platform balance checks, match-confidence threshold
- **Dry-run mode on by default** — logs all opportunities and simulated executions without placing real orders
- **Bloomberg terminal dashboard** — retro-futuristic React UI with live P&L metrics, opportunity feed, trade history, and bot controls
- **Persistent SQLite database** — all opportunities and trades recorded for post-analysis
- **Typed event bus** — fully typed internal pub/sub for clean component communication
- **Graceful shutdown** — handles `SIGINT`/`SIGTERM`, cleans up connectors and open orders

---

## Architecture

```
┌─────────────────────┐        ┌─────────────────────┐
│  PolymarketConnector │        │  PredictFunConnector │
│  (Gamma + CLOB APIs) │        │  (REST API)          │
└──────────┬──────────┘        └──────────┬────────────┘
           │         implements            │
           │       MarketConnector         │
           └───────────────┬──────────────┘
                           │
                  ┌────────▼─────────┐
                  │   MarketMatcher   │
                  │                   │
                  │  Pass 1: slug      │  exact slug → 0.95 confidence
                  │  Pass 2: Fuse.js   │  fuzzy text + date/category boost
                  └────────┬──────────┘
                           │  MarketPair[]
                  ┌────────▼──────────────────────┐
                  │         Strategy Engine         │
                  │  ┌────────────────────────────┐ │
                  │  │  CrossPlatformArbStrategy   │ │  ← extensible
                  │  │                             │ │
                  │  │  for each pair:             │ │
                  │  │    fetch both order books   │ │
                  │  │    check YES+NO cost < $1   │ │
                  │  │    check NO+YES cost < $1   │ │
                  │  │    emit ArbitrageOpportunity │ │
                  │  └────────────────────────────┘ │
                  └────────┬──────────────────────────┘
                           │  ArbitrageOpportunity[]
                  ┌────────▼──────────────────┐
                  │      ExecutionEngine        │
                  │  ┌─────────────────────┐   │
                  │  │    Risk Manager      │   │  position limits
                  │  │  - max positions     │   │  exposure cap
                  │  │  - exposure cap      │   │  balance checks
                  │  │  - balance check     │   │  confidence floor
                  │  │  - confidence floor  │   │
                  │  └─────────────────────┘   │
                  │  → place both legs          │
                  └────────┬──────────────────────┘
                           │
                  ┌────────▼──────────────────┐
                  │       Bot Orchestrator      │
                  │  ┌───────────────────────┐ │
                  │  │     Event Bus (typed)  │ │
                  │  └───────────────────────┘ │
                  │  ┌───────────────────────┐ │
                  │  │    SQLite Database     │ │  opportunities
                  │  └───────────────────────┘ │  trades, metrics
                  │  ┌───────────────────────┐ │
                  │  │  API Server            │ │  REST + WebSocket
                  │  │  (Express + ws)        │ │  → dashboard
                  │  └───────────────────────┘ │
                  └───────────────────────────────┘
```

---

## Project structure

```
pred-arb/
├── src/
│   ├── types/
│   │   ├── market.ts          # NormalizedMarket, OrderBook, ArbitrageOpportunity, TradeRecord, …
│   │   ├── connector.ts       # MarketConnector interface
│   │   └── strategy.ts        # Strategy interface
│   │
│   ├── connectors/
│   │   ├── base-connector.ts  # Abstract base with HTTP helpers and retry logic
│   │   ├── polymarket.ts      # Polymarket Gamma + CLOB connector
│   │   └── predictfun.ts      # predict.fun REST connector
│   │
│   ├── matcher/
│   │   └── market-matcher.ts  # Fuse.js fuzzy matching + slug/date/category heuristics
│   │
│   ├── strategies/
│   │   └── cross-platform-arb.ts  # YES+NO complement arbitrage strategy
│   │
│   ├── engine/
│   │   ├── bot.ts             # Main orchestrator — scan loop, startup, shutdown
│   │   ├── execution-engine.ts # Validate → risk check → place orders
│   │   ├── risk-manager.ts    # Pre-trade risk checks and position tracking
│   │   └── api-server.ts      # Express REST + WebSocket server
│   │
│   ├── db/
│   │   └── database.ts        # SQLite schema, CRUD helpers, dashboard metrics query
│   │
│   ├── utils/
│   │   ├── config.ts          # Centralized env-var config
│   │   ├── logger.ts          # Winston structured logger
│   │   └── event-bus.ts       # Typed pub/sub event bus
│   │
│   └── index.ts               # Entry point + graceful shutdown
│
├── dashboard/
│   ├── app/
│   │   ├── layout.tsx         # Root layout + fonts
│   │   ├── page.tsx           # Terminal dashboard (React)
│   │   └── globals.css        # Bloomberg terminal styles
│   ├── next.config.ts         # Next.js (static export)
│   └── package.json
│
├── data/                      # SQLite DB created here at runtime
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Setup

### Prerequisites

- Node.js 18+
- A funded USDC wallet on Polygon (for Polymarket live mode)

### Install

```bash
git clone <repo>
cd pred-arb
npm run setup          # installs backend + dashboard deps
cp .env.example .env
```

### Configure

Edit `.env`:

```env
# Polymarket — needed only for live order placement
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
POLYMARKET_PRIVATE_KEY=       # EOA private key for EIP-712 order signing
POLYMARKET_CHAIN_ID=137

# predict.fun — needed only for live order placement
PREDICTFUN_API_KEY=
PREDICTFUN_PRIVATE_KEY=

# Bot parameters
MIN_PROFIT_BPS=150            # 1.5% minimum profit after fees
MAX_POSITION_USD=500          # max spend per trade leg
MAX_TOTAL_EXPOSURE_USD=5000   # total outstanding exposure cap
SCAN_INTERVAL_MS=10000        # scan every 10 seconds

# Ports
API_PORT=3848
DASHBOARD_PORT=3847
```

> **Credentials are only required for live trading.** The bot reads public market data and runs in dry-run mode without any keys configured.

---

## Running

```bash
# Development (hot-reload bot + separate dashboard dev server)
npm run start:dev          # terminal 1 — bot on :3848
npm run dashboard:dev      # terminal 2 — Next.js dashboard on :3847
# For dev: copy dashboard/.env.local.example to dashboard/.env.local
# and set NEXT_PUBLIC_WS_URL=ws://localhost:3848 (Next.js doesn't proxy WebSockets)

# Production
npm run build:all          # compile backend + build dashboard
npm start                  # serves bot + dashboard together on :3848
```

Open `http://localhost:3847` (dev) or `http://localhost:3848` (production) for the dashboard.

---

## Dashboard

The admin dashboard uses a retro-futuristic Bloomberg terminal aesthetic — amber/green on black, JetBrains Mono, ASCII sparklines, scanline overlay.

**Panels:**

| Panel | Description |
|---|---|
| Metrics strip | Rolling 24h / 7d / all-time P&L, win rate, trade count, avg profit, equity sparkline |
| Arbitrage Opportunities | Live feed of discovered opportunities with platforms, outcomes, prices, expected profit, match confidence |
| Activity Feed | Real-time event stream (scan completions, trade executions, risk alerts) |
| Trade History | All executed trades with leg details, realized P&L, fees, and status |
| Strategy Config | Active strategies, parameters, and system architecture diagram |

**Bot controls:**

- **PAUSE** — suspends the scan loop, leaves open orders as-is
- **RESUME** — resumes scanning
- **STOP** — graceful shutdown of all connectors and strategies

The dashboard connects over WebSocket for push updates and falls back to REST polling every 5 seconds.

---

## Adding a new platform

Implement the `MarketConnector` interface (10 methods):

```typescript
// src/connectors/my-platform.ts
import { BaseConnector } from './base-connector';

export class MyPlatformConnector extends BaseConnector {
  readonly platform: Platform = 'myplatform';
  readonly name = 'My Platform';

  async connect(): Promise<void> { /* test connectivity */ }
  async disconnect(): Promise<void> { /* cleanup */ }
  async fetchMarkets(opts?: FetchMarketsOptions): Promise<NormalizedMarket[]> { /* ... */ }
  async fetchMarket(id: string): Promise<NormalizedMarket | null> { /* ... */ }
  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> { /* ... */ }
  async placeOrder(order: OrderRequest): Promise<OrderResult> { /* ... */ }
  async cancelOrder(orderId: string): Promise<boolean> { /* ... */ }
  async getOpenOrders(): Promise<OrderResult[]> { /* ... */ }
  async getPositions(): Promise<Position[]> { /* ... */ }
  async getBalance(): Promise<number> { /* ... */ }
}
```

Then register it in `src/engine/bot.ts`:

```typescript
const myPlatform = new MyPlatformConnector();
this.connectors.set('myplatform', myPlatform);
```

Add `'myplatform'` to the `Platform` union type in `src/types/market.ts`.

---

## Adding a new strategy

Implement the `Strategy` interface:

```typescript
// src/strategies/my-strategy.ts
export class MyStrategy implements Strategy {
  readonly id = 'my-strategy';
  readonly name = 'My Strategy';
  readonly description = '...';
  readonly platforms: Platform[] = ['polymarket', 'predictfun'];
  readonly config: StrategyConfig = { /* ... */ };

  async initialize(connectors: Map<Platform, MarketConnector>): Promise<void> { /* ... */ }
  async shutdown(): Promise<void> { /* ... */ }

  async scan(): Promise<ArbitrageOpportunity[]> {
    // Your logic here — return opportunities, never execute directly
  }

  async validate(opportunity: ArbitrageOpportunity): Promise<boolean> {
    // Re-check prices just before execution
  }

  getMetrics(): StrategyMetrics { /* ... */ }
}
```

Register it in `bot.ts`:

```typescript
const myStrategy = new MyStrategy();
await myStrategy.initialize(this.connectors);
this.strategies.set(myStrategy.id, myStrategy);
```

---

## Risk management

All trades pass through the `RiskManager` before execution. Checks in order:

1. **Max open positions** — hard cap of 20 concurrent positions
2. **Total exposure cap** — sum of all outstanding position costs cannot exceed `MAX_TOTAL_EXPOSURE_USD`; oversized trades are scaled down rather than rejected
3. **Per-trade size limit** — enforces `MAX_POSITION_USD` per leg
4. **Balance check** — verifies sufficient balance on both platforms with a 10% reserve held back
5. **Match confidence floor** — rejects opportunities where the market match confidence is below 0.6

---

## Live trading notes

> ⚠️ The bot starts in **dry-run mode** (`dryRun = true` in `bot.ts`). All opportunities are logged and simulated, but no real orders are placed. Review simulated P&L before going live.

To enable live trading, change `bot.ts`:

```typescript
this.executionEngine = new ExecutionEngine(this.riskManager, /* dryRun */ false);
```

**Polymarket** requires:
- A funded USDC wallet on Polygon (chain ID 137)
- API credentials generated via the CLOB API (`create_or_derive_api_creds`)
- EIP-712 order signing with your private key

**predict.fun** requires:
- An API key from predict.fun
- Wallet signing for order authentication

---

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5, Node.js 18+ |
| HTTP | Native `fetch` (Node 18+) with exponential backoff |
| WebSocket | `ws` library |
| Market matching | Fuse.js (fuzzy search) |
| Database | SQLite via `better-sqlite3` |
| API server | Express |
| Logging | Winston (structured JSON) |
| Dashboard | React 18, Next.js 15 (static export) |
| Wallet / signing | ethers.js v6 |
| Configuration | dotenv |

---

## Development

```bash
npm run typecheck        # TypeScript type check (no emit)
npm run build            # Compile to build/
npm run build:dashboard  # Build dashboard to dashboard/out/
npm run build:all        # Both
```

Logs are written to stdout in JSON format (Winston). Set `LOG_LEVEL=debug` for verbose connector output.
