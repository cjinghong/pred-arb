// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Polymarket Connector
// Connects to Polymarket's Gamma API (markets) and CLOB API (order books)
// ═══════════════════════════════════════════════════════════════════════════

import { BaseConnector } from './base-connector';
import {
  FetchMarketsOptions,
  NormalizedMarket,
  OrderBook,
  OrderRequest,
  OrderResult,
  Platform,
  Position,
  PriceLevel,
} from '../types';
import { config } from '../utils/config';

// ─── Raw Polymarket API Types ────────────────────────────────────────────

interface PolymarketRawMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  category: string;
  outcomes: string;           // JSON string: '["Yes","No"]'
  outcomePrices: string;      // JSON string: '[0.65, 0.35]'
  clobTokenIds: string;       // JSON string: '["token1","token2"]'
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  updatedAt: string;
}

interface PolymarketRawOrderBook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  min_tick_size?: number;
  hash?: string;
}

// ─── Connector Implementation ────────────────────────────────────────────

export class PolymarketConnector extends BaseConnector {
  readonly platform: Platform = 'polymarket';
  readonly name = 'Polymarket';

  private gammaUrl: string;
  private clobUrl: string;

  constructor() {
    super('polymarket');
    this.gammaUrl = config.polymarket.gammaUrl;
    this.clobUrl = config.polymarket.clobUrl;
  }

  async connect(): Promise<void> {
    try {
      // Test connectivity by fetching a single market
      await this.httpGet(`${this.gammaUrl}/markets?limit=1`);
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to Polymarket');
    } catch (err) {
      this.log.error('Failed to connect to Polymarket', { error: (err as Error).message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.emit('disconnected');
    this.log.info('Disconnected from Polymarket');
  }

  // ─── Market Data ───────────────────────────────────────────────────────

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 100));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.activeOnly !== false) params.set('active', 'true');
    params.set('closed', 'false');

    const raw = await this.httpGet<PolymarketRawMarket[]>(
      `${this.gammaUrl}/markets?${params.toString()}`
    );

    return raw
      .filter(m => {
        try {
          const outcomes = JSON.parse(m.outcomes || '[]');
          return outcomes.length === 2; // binary markets only for now
        } catch {
          return false;
        }
      })
      .map(m => this.normalizeMarket(m))
      .filter(m => {
        if (options?.minLiquidity && m.liquidity < options.minLiquidity) return false;
        return true;
      });
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const raw = await this.httpGet<PolymarketRawMarket>(
        `${this.gammaUrl}/markets/${marketId}`
      );
      return this.normalizeMarket(raw);
    } catch {
      return null;
    }
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    // First we need the token ID for this outcome
    const market = await this.fetchMarket(marketId);
    if (!market) throw new Error(`Market ${marketId} not found`);

    const tokenId = market.outcomeTokenIds[outcomeIndex];
    if (!tokenId) throw new Error(`No token for outcome index ${outcomeIndex}`);

    const raw = await this.httpGet<PolymarketRawOrderBook>(
      `${this.clobUrl}/book?token_id=${tokenId}`
    );

    return this.normalizeOrderBook(raw, marketId, outcomeIndex);
  }

  /** Batch-fetch order books for multiple token IDs */
  async fetchOrderBooks(tokenIds: string[]): Promise<Map<string, PolymarketRawOrderBook>> {
    const result = new Map<string, PolymarketRawOrderBook>();

    // CLOB supports batch via POST /books
    try {
      const books = await this.httpPost<PolymarketRawOrderBook[]>(
        `${this.clobUrl}/books`,
        tokenIds,
      );
      for (const book of books) {
        result.set(book.asset_id, book);
      }
    } catch (err) {
      this.log.warn('Batch book fetch failed, falling back to individual', {
        error: (err as Error).message,
      });
      // Fallback: fetch individually
      for (const tokenId of tokenIds) {
        try {
          const book = await this.httpGet<PolymarketRawOrderBook>(
            `${this.clobUrl}/book?token_id=${tokenId}`
          );
          result.set(tokenId, book);
        } catch {
          this.log.warn(`Failed to fetch book for token ${tokenId}`);
        }
      }
    }

    return result;
  }

  // ─── Trading (requires auth) ───────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // NOTE: Full order signing requires EIP-712 integration with ethers.js
    // This is a scaffold — production would use the Polymarket CLOB client SDK
    this.log.info('Placing order on Polymarket', { order });

    const market = await this.fetchMarket(order.marketId);
    if (!market) throw new Error(`Market ${order.marketId} not found`);

    const tokenId = market.outcomeTokenIds[order.outcomeIndex];

    // In production, this would:
    // 1. Build the order struct
    // 2. Sign with EIP-712
    // 3. POST to CLOB /order endpoint
    const orderPayload = {
      tokenID: tokenId,
      price: order.price,
      size: order.size,
      side: order.side,
      feeRateBps: 0,
      nonce: Date.now().toString(),
    };

    this.log.info('Order payload prepared (dry-run mode)', { orderPayload });

    // Return a simulated result for now
    return {
      id: `poly_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      platform: 'polymarket',
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side,
      type: order.type,
      price: order.price,
      size: order.size,
      filledSize: 0,
      avgFillPrice: 0,
      status: 'PENDING',
      timestamp: new Date(),
      fees: 0,
      raw: orderPayload,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.log.info('Cancelling order on Polymarket', { orderId });
    // Would DELETE to CLOB /order/{orderId}
    return true;
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    // Would GET from CLOB /orders with API credentials
    return [];
  }

  async getPositions(): Promise<Position[]> {
    // Would GET from data-api with API credentials
    return [];
  }

  async getBalance(): Promise<number> {
    // Would query USDC balance on Polygon
    return 0;
  }

  // ─── Normalization ─────────────────────────────────────────────────────

  private normalizeMarket(raw: PolymarketRawMarket): NormalizedMarket {
    let outcomes: string[] = [];
    let outcomePrices: number[] = [];
    let tokenIds: string[] = [];

    try { outcomes = JSON.parse(raw.outcomes || '[]'); } catch { outcomes = []; }
    try { outcomePrices = JSON.parse(raw.outcomePrices || '[]').map(Number); } catch { outcomePrices = []; }
    try { tokenIds = JSON.parse(raw.clobTokenIds || '[]'); } catch { tokenIds = []; }

    return {
      id: raw.id || raw.conditionId,
      platform: 'polymarket',
      question: raw.question,
      slug: raw.slug,
      category: raw.category || '',
      outcomes,
      outcomeTokenIds: tokenIds,
      outcomePrices,
      volume: raw.volume || 0,
      liquidity: raw.liquidity || 0,
      active: raw.active && !raw.closed,
      endDate: raw.endDate ? new Date(raw.endDate) : null,
      lastUpdated: new Date(raw.updatedAt || Date.now()),
      raw,
    };
  }

  private normalizeOrderBook(
    raw: PolymarketRawOrderBook,
    marketId: string,
    outcomeIndex: number,
  ): OrderBook {
    const bids: PriceLevel[] = (raw.bids || []).map(b => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })).sort((a, b) => b.price - a.price);

    const asks: PriceLevel[] = (raw.asks || []).map(a => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })).sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    return {
      platform: 'polymarket',
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: raw.min_tick_size || 0.01,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: new Date(parseInt(raw.timestamp) * 1000 || Date.now()),
    };
  }
}
