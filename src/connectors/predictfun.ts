// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: predict.fun Connector
// Connects to the predict.fun REST API for markets and order books
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

// ─── Raw predict.fun API Types ───────────────────────────────────────────

interface PredictFunRawMarket {
  id: string;
  title: string;
  slug: string;
  category: string;
  outcomes: Array<{ id: string; title: string; price: number }>;
  volume: number;
  liquidity: number;
  status: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

interface PredictFunMarketsResponse {
  data: PredictFunRawMarket[];
  pageInfo?: {
    hasNextPage: boolean;
    endCursor: string;
  };
}

interface PredictFunRawOrderBook {
  bids: Array<[number, number]>;  // [price, quantity]
  asks: Array<[number, number]>;  // [price, quantity]
}

interface PredictFunAuthMessage {
  message: string;
}

// ─── Connector Implementation ────────────────────────────────────────────

export class PredictFunConnector extends BaseConnector {
  readonly platform: Platform = 'predictfun';
  readonly name = 'predict.fun';

  private apiUrl: string;
  private jwtToken: string | null = null;

  constructor() {
    super('predictfun');
    this.apiUrl = config.predictfun.useTestnet
      ? config.predictfun.testnetUrl
      : config.predictfun.apiUrl;
  }

  async connect(): Promise<void> {
    try {
      // Test connectivity
      await this.httpGet(`${this.apiUrl}/v1/markets?first=1`);
      this._isConnected = true;
      this.emit('connected');
      this.log.info('Connected to predict.fun', { url: this.apiUrl });
    } catch (err) {
      this.log.error('Failed to connect to predict.fun', { error: (err as Error).message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.jwtToken = null;
    this._isConnected = false;
    this.emit('disconnected');
    this.log.info('Disconnected from predict.fun');
  }

  /** Authenticate and get JWT token */
  private async authenticate(): Promise<void> {
    if (!config.predictfun.apiKey || !config.predictfun.privateKey) {
      this.log.warn('predict.fun credentials not configured — trading disabled');
      return;
    }

    // Step 1: Get auth message
    const { message } = await this.httpGet<PredictFunAuthMessage>(
      `${this.apiUrl}/v1/auth/message`
    );

    // Step 2: Sign message with private key (would use ethers.js)
    // For now, this is a scaffold
    this.log.info('Auth message received, signing required for trading');

    // Step 3: Exchange for JWT
    // const jwt = await this.httpPost(`${this.apiUrl}/v1/auth`, { ... });
    // this.jwtToken = jwt.token;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.predictfun.apiKey) {
      headers['x-api-key'] = config.predictfun.apiKey;
    }
    if (this.jwtToken) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }
    return headers;
  }

  // ─── Market Data ───────────────────────────────────────────────────────

  async fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]> {
    const params = new URLSearchParams();
    params.set('first', String(options?.limit ?? 100));
    if (options?.offset) params.set('after', String(options.offset));

    const response = await this.httpGet<PredictFunMarketsResponse>(
      `${this.apiUrl}/v1/markets?${params.toString()}`,
      this.getAuthHeaders(),
    );

    const markets = response.data || response as unknown as PredictFunRawMarket[];

    return (Array.isArray(markets) ? markets : [])
      .filter(m => {
        // Only binary markets
        const outcomes = m.outcomes || [];
        return outcomes.length === 2;
      })
      .map(m => this.normalizeMarket(m))
      .filter(m => {
        if (options?.activeOnly !== false && !m.active) return false;
        if (options?.minLiquidity && m.liquidity < options.minLiquidity) return false;
        return true;
      });
  }

  async fetchMarket(marketId: string): Promise<NormalizedMarket | null> {
    try {
      const raw = await this.httpGet<PredictFunRawMarket>(
        `${this.apiUrl}/v1/markets/${marketId}`,
        this.getAuthHeaders(),
      );
      return this.normalizeMarket(raw);
    } catch {
      return null;
    }
  }

  async fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook> {
    const raw = await this.httpGet<PredictFunRawOrderBook>(
      `${this.apiUrl}/v1/markets/${marketId}/orderbook`,
      this.getAuthHeaders(),
    );

    return this.normalizeOrderBook(raw, marketId, outcomeIndex);
  }

  // ─── Trading (requires auth) ───────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.jwtToken && !config.predictfun.apiKey) {
      throw new Error('predict.fun: not authenticated for trading');
    }

    this.log.info('Placing order on predict.fun', { order });

    const orderPayload = {
      marketId: order.marketId,
      outcomeIndex: order.outcomeIndex,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.size,
    };

    this.log.info('Order payload prepared (dry-run mode)', { orderPayload });

    return {
      id: `pfun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      platform: 'predictfun',
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
    this.log.info('Cancelling order on predict.fun', { orderId });
    return true;
  }

  async getOpenOrders(): Promise<OrderResult[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getBalance(): Promise<number> {
    return 0;
  }

  // ─── Normalization ─────────────────────────────────────────────────────

  private normalizeMarket(raw: PredictFunRawMarket): NormalizedMarket {
    const outcomes = (raw.outcomes || []).map(o => o.title || 'Unknown');
    const outcomePrices = (raw.outcomes || []).map(o => o.price || 0);
    const outcomeTokenIds = (raw.outcomes || []).map(o => o.id || '');

    return {
      id: raw.id,
      platform: 'predictfun',
      question: raw.title,
      slug: raw.slug || '',
      category: raw.category || '',
      outcomes,
      outcomeTokenIds,
      outcomePrices,
      volume: raw.volume || 0,
      liquidity: raw.liquidity || 0,
      active: raw.status === 'active' || raw.status === 'ACTIVE',
      endDate: raw.endDate ? new Date(raw.endDate) : null,
      lastUpdated: new Date(raw.updatedAt || Date.now()),
      raw,
    };
  }

  private normalizeOrderBook(
    raw: PredictFunRawOrderBook,
    marketId: string,
    outcomeIndex: number,
  ): OrderBook {
    // predict.fun returns [price, quantity] tuples
    // Prices are for YES outcome. For NO, we need to invert.
    const isYes = outcomeIndex === 0;

    let bids: PriceLevel[];
    let asks: PriceLevel[];

    if (isYes) {
      bids = (raw.bids || []).map(([price, size]) => ({ price, size }))
        .sort((a, b) => b.price - a.price);
      asks = (raw.asks || []).map(([price, size]) => ({ price, size }))
        .sort((a, b) => a.price - b.price);
    } else {
      // For NO outcome: flip bid/ask and invert prices
      // A YES ask at 0.60 = a NO bid at 0.40
      // A YES bid at 0.55 = a NO ask at 0.45
      bids = (raw.asks || []).map(([price, size]) => ({ price: 1 - price, size }))
        .sort((a, b) => b.price - a.price);
      asks = (raw.bids || []).map(([price, size]) => ({ price: 1 - price, size }))
        .sort((a, b) => a.price - b.price);
    }

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    return {
      platform: 'predictfun',
      marketId,
      outcomeIndex,
      bids,
      asks,
      minOrderSize: 1,
      tickSize: 0.01,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: new Date(),
    };
  }
}
