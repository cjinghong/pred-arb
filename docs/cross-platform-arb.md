# Cross-Platform Prediction Market Arbitrage

A detailed explanation of the hold-to-resolution (HTR) arbitrage strategy used by PRED-ARB.

---

## 1. The core insight

Binary prediction markets offer contracts that settle at exactly **$1.00** if an event occurs and **$0.00** if it doesn't. On any single platform, YES and NO prices should sum to $1.00 (before fees). But across different platforms listing the same event, prices can diverge because each platform has its own pool of liquidity and traders.

When the combined cost of buying YES on one platform and NO on another for the same event is less than $1.00, you have a risk-free arbitrage opportunity. You are guaranteed a $1.00 payout regardless of the outcome, and your profit is the difference between $1.00 and your total cost.

This is sometimes called **hold-to-resolution (HTR)** arbitrage because you hold both positions until the market resolves. There is no directional risk — you profit from pricing inefficiency, not from predicting the outcome.

---

## 2. How it works — step by step

### Setup

Two platforms list the same binary event, for example: "Will BTC reach $100k by June 2026?"

| | Polymarket | predict.fun |
|---|---|---|
| YES ask | $0.52 | $0.55 |
| NO ask (= 1 - YES bid) | $0.46 | $0.48 |

### Direction 1: Buy YES on Polymarket + Buy NO on predict.fun

- Cost of YES on Polymarket: **$0.52** (the best ask price)
- Cost of NO on predict.fun: **$0.48** (= 1 - best YES bid = 1 - $0.52... wait, let's use actual NO pricing)

In practice, "buying NO" means taking the other side of a YES order:

- To buy NO on predict.fun, you look at predict.fun's YES bid price. If someone is bidding $0.55 for YES, then NO costs $1 - $0.55 = **$0.45**.

So:
- Cost: $0.52 (YES on Poly) + $0.45 (NO on PredictFun) = **$0.97**
- Payout: **$1.00** (guaranteed)
- Profit: **$0.03 per share** (≈ 309 bps on cost)

### Direction 2: Buy NO on Polymarket + Buy YES on predict.fun

Using the same book:
- NO on Polymarket = 1 - Poly YES bid. If Poly YES bid = $0.50, NO costs $0.50.
- YES on predict.fun = $0.55 (the ask)
- Cost: $0.50 + $0.55 = **$1.05** → **No arb** (cost > $1.00)

The strategy checks both directions every time an order book updates and only flags opportunities where total cost < $1.00.

---

## 3. Outcome table

| Scenario | You Hold | Payout | Cost | Profit |
|---|---|---|---|---|
| Event happens (YES) | YES on Platform A pays $1 | $1.00 | $0.97 | +$0.03 |
| | NO on Platform B pays $0 | | | |
| Event doesn't happen (NO) | YES on Platform A pays $0 | $1.00 | $0.97 | +$0.03 |
| | NO on Platform B pays $1 | | | |

The profit is identical regardless of the outcome. This is what makes it risk-free (excluding execution risk and fees).

---

## 4. Sizing logic

The strategy sizes each trade to maximize profit without moving the order book price. It takes the **minimum available quantity at the best price level** across both platforms:

```
maxSizeA = bestAskSizeOnPlatformA   (e.g., 12 shares at $0.52)
maxSizeB = bestBidSizeOnPlatformB   (e.g., 10 shares at $0.55)
maxSize  = min(maxSizeA, maxSizeB, maxPositionUsd / totalCost)
```

If Platform A has 12 shares at the best ask and Platform B has 10 shares at the best bid, the strategy takes **10 shares on both sides**. This ensures:

1. Both legs execute at the best price without walking the book
2. The position is perfectly balanced (same quantity on both sides)
3. The `maxPositionUsd` cap provides an additional safety bound

### Why not walk the book?

Walking the book (consuming multiple price levels) introduces slippage risk. If you send an order for 100 shares but only 10 are available at $0.52 and the next 90 are at $0.54, your effective cost changes. The arb might still be profitable, but the calculation becomes uncertain, especially when executing both legs simultaneously across two different platforms. By limiting to the top-of-book quantity, we ensure both legs execute at known prices.

### Minimum depth filter

The `MIN_DEPTH_USD` parameter (default: $50) rejects opportunities where the available depth is too small to be worth executing. A $0.03 profit on 2 shares ($0.06 total) isn't worth the gas fees and execution risk. Set to 0 for testing.

---

## 5. Event-driven scanning

Rather than polling order books on a fixed interval, the bot uses **WebSocket-driven scanning**:

1. Both connectors maintain WebSocket connections to their respective platforms
2. When an order book update arrives, the `ws-orderbook-manager` emits a `book:update` event
3. The strategy maintains a **reverse index** mapping each market ID to its matched pair(s)
4. On each `book:update`, the strategy performs an O(1) lookup to find affected pairs
5. Only the affected pair is re-analyzed — not the entire universe

This approach means the bot detects opportunities within milliseconds of a price change, rather than waiting for the next polling cycle. A 200ms debounce prevents redundant re-analysis when multiple updates arrive in quick succession for the same pair.

```
WS update: predict.fun market X price changed
  → lookup marketToPairs[X] → found pair P
  → check: is pair P approved? yes
  → check: last analyzed < 200ms ago? no
  → fetch both order books
  → compute arb in both directions
  → if profitable: emit opportunity → execution engine
```

---

## 6. Market matching

Before the strategy can check for arbitrage, it needs to identify which markets on Polymarket correspond to which markets on predict.fun. This is handled by the `MarketMatcher`:

### Pass 1: Exact slug match
Markets with identical slugs (URL-friendly identifiers) are matched with 0.95 confidence. This catches markets that were clearly listed from the same source data.

### Pass 2: Fuzzy text matching (Fuse.js)
For markets without exact slug matches, the matcher uses Fuse.js to find text-similar questions. Confidence is boosted by matching end dates, categories, and market structure (both binary, same number of outcomes).

### Pass 3: LLM verification (optional)
If an `ANTHROPIC_API_KEY` is set, the matcher sends candidate pairs to Claude for semantic verification. The LLM determines whether two differently-worded questions refer to the same real-world event. Pairs that pass LLM verification are automatically promoted to "approved" status.

### Pair statuses

Each matched pair has a status that controls whether it's eligible for arb scanning:

| Status | Description | Scannable? |
|---|---|---|
| `pending` | Newly matched, awaiting review | No |
| `approved` | Confirmed equivalent, ready for trading | Yes |
| `paused` | Temporarily excluded | No |
| `rejected` | Confirmed non-match, permanently excluded | No |

Without an LLM key, all pairs start as `pending` and must be manually approved via the dashboard. With an LLM key, high-confidence matches are auto-approved.

---

## 7. Execution flow

When an opportunity is detected:

```
Opportunity detected
  → ExecutionEngine.submit(opportunity)
  → Strategy.validate(opportunity)       # re-fetch books, confirm still profitable
  → RiskManager.checkPreTrade()          # position limits, exposure, balance
  → Place leg A order (YES on platform X)
  → Place leg B order (NO on platform Y)
  → Record trade in database
  → Emit trade:executed or trade:failed event
```

In dry-run mode (default), the execution engine logs what it would have done without placing real orders.

---

## 8. Risk considerations

### Execution risk
The two legs are placed sequentially, not atomically. If leg A fills but leg B doesn't (e.g., the price moved), you're left with a directional position. Mitigation: validate prices immediately before execution, use limit orders, and implement cancel-on-fail logic.

### Settlement risk
Both positions must be held until market resolution. If a market is cancelled or voided on one platform but not the other, the arb assumption breaks down.

### Liquidity risk
Thin order books mean small position sizes. The profit per trade might be small in absolute terms even if the bps spread is attractive.

### Fee risk
Both platforms charge fees (trading fees, gas fees on-chain). The strategy must account for fees in its profit calculation. A 3% gross arb might become unprofitable after 1% fees on each side.

### Counterparty risk
Funds are locked on two different platforms until resolution. If a platform becomes insolvent or freezes withdrawals, some capital is at risk.

### Timing risk
Markets can resolve at different times on different platforms. If one platform resolves early and the other doesn't, capital is locked longer than expected.

---

## 9. Configuration reference

| Parameter | Env Variable | Default | Description |
|---|---|---|---|
| Min profit | `MIN_PROFIT_BPS` | 150 | Minimum profit threshold in basis points. Use negative values for testing. |
| Max position | `MAX_POSITION_USD` | 500 | Maximum spend per trade leg in USD |
| Max exposure | `MAX_TOTAL_EXPOSURE_USD` | 5000 | Total outstanding exposure cap across all positions |
| Min depth | `MIN_DEPTH_USD` | 50 | Minimum order book depth in USD to consider an opportunity |
| Pair refresh | `PAIR_REFRESH_INTERVAL_MS` | 300000 | How often to re-fetch markets and run matching (5 min) |
| Scan interval | `SCAN_INTERVAL_MS` | 10000 | Fallback scan interval (primary scanning is WS-driven) |

---

## 10. Dashboard: reading the arb analysis

When you click a matched pair in the dashboard, the pair detail page shows live order books side by side with an arb summary:

```
ARB ANALYSIS
D1  YES POLYM + NO PREDF   Cost: 0.970   Size: 45   +0.030 (309 bps)
D2  NO POLYM + YES PREDF   Cost: 1.050   Size: 30   -0.050 (-476 bps)
```

- **D1 / D2**: Direction 1 and Direction 2 of the arb
- **Cost**: Total cost per share for both legs combined
- **Size**: Maximum executable size at current best prices (min of both sides)
- **Profit/Loss**: Per-share profit and basis points. Green = profitable arb, Red = no arb

Use the **YES/NO toggle** on each book to inspect the NO order book directly. The arb calculation always uses the YES books (since NO price = 1 - YES bid/ask), but viewing the NO book helps you understand the liquidity profile on both sides.
