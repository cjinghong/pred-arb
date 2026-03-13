// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Base Connector
// Abstract base class with shared logic for all platform connectors
// ═══════════════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import {
  MarketConnector,
  ConnectorEvent,
  ConnectorEventHandler,
  FetchMarketsOptions,
  Platform,
  NormalizedMarket,
  OrderBook,
  OrderRequest,
  OrderResult,
  Position,
} from '../types';
import { createChildLogger } from '../utils/logger';

export abstract class BaseConnector implements MarketConnector {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  protected _isConnected = false;
  protected _isWsConnected = false;
  protected events = new EventEmitter();
  protected log;

  constructor(logModule: string) {
    this.log = createChildLogger(logModule);
    this.events.setMaxListeners(20);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get isWsConnected(): boolean {
    return this._isWsConnected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract fetchMarkets(options?: FetchMarketsOptions): Promise<NormalizedMarket[]>;
  abstract fetchMarket(marketId: string): Promise<NormalizedMarket | null>;
  abstract fetchOrderBook(marketId: string, outcomeIndex: number): Promise<OrderBook>;
  abstract subscribeOrderBooks(markets: NormalizedMarket[]): void;
  abstract unsubscribeOrderBooks(marketIds: string[]): void;
  abstract placeOrder(order: OrderRequest): Promise<OrderResult>;
  abstract cancelOrder(orderId: string): Promise<boolean>;
  abstract getOpenOrders(): Promise<OrderResult[]>;
  abstract getPositions(): Promise<Position[]>;
  abstract getBalance(): Promise<number>;

  on(event: ConnectorEvent, handler: ConnectorEventHandler): void {
    this.events.on(event, handler);
  }

  off(event: ConnectorEvent, handler: ConnectorEventHandler): void {
    this.events.off(event, handler);
  }

  protected emit(event: ConnectorEvent, data?: unknown): void {
    this.events.emit(event, event, data);
  }

  /** HTTP fetch with error handling and retries */
  protected async httpGet<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json', ...headers },
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 500;
          this.log.warn(`Request failed, retrying in ${delay}ms`, { url, attempt, error: (err as Error).message });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  /** HTTP POST with error handling */
  protected async httpPost<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    return (await res.json()) as T;
  }
}
