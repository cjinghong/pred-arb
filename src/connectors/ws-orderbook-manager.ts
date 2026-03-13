// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: WebSocket Order Book Manager
// Shared infrastructure for real-time order book streaming across platforms.
// Maintains in-memory order book state updated via WebSocket push events,
// so strategies can read books instantly instead of polling REST.
// ═══════════════════════════════════════════════════════════════════════════

import WebSocket from 'ws';
import { OrderBook, Platform, PriceLevel } from '../types';
import { createChildLogger } from '../utils/logger';
import { eventBus } from '../utils/event-bus';

export interface WsOrderBookManagerConfig {
  /** Platform identifier */
  platform: Platform;
  /** WebSocket URL to connect to */
  wsUrl: string;
  /** Maximum reconnection attempts before giving up (0 = infinite) */
  maxReconnects: number;
  /** Initial reconnect delay in ms (doubles each attempt) */
  reconnectBaseDelayMs: number;
  /** Maximum reconnect delay in ms */
  reconnectMaxDelayMs: number;
  /** Heartbeat interval check in ms (0 = disabled) */
  heartbeatIntervalMs: number;
  /** Stale threshold — book is "stale" if older than this (ms) */
  staleThresholdMs: number;
}

export type WsSubscribeMessage = (assetIds: string[]) => string;
export type WsUnsubscribeMessage = (assetIds: string[]) => string;
export type WsHeartbeatResponse = (msg: unknown) => string | null;
export type WsBookParser = (raw: unknown) => ParsedBookUpdate | null;

export interface ParsedBookUpdate {
  assetId: string;
  marketId: string;
  outcomeIndex: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: Date;
  minOrderSize?: number;
  tickSize?: number;
}

/**
 * Manages a single WebSocket connection to a prediction market platform.
 * Receives order book updates, maintains local state, and provides
 * instant access to the latest book for any tracked asset.
 */
export class WsOrderBookManager {
  private ws: WebSocket | null = null;
  private config: WsOrderBookManagerConfig;
  private log;

  /** In-memory cache: assetId → latest OrderBook */
  private books = new Map<string, OrderBook>();

  /** Map of assetId → marketId for reverse lookups */
  private assetToMarket = new Map<string, { marketId: string; outcomeIndex: number }>();

  /** Currently subscribed asset IDs */
  private subscribedAssets = new Set<string>();

  /** Reconnection state */
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionalClose = false;

  /** Heartbeat state */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;

  /** Callbacks — set by the platform connector */
  private buildSubscribeMsg: WsSubscribeMessage;
  private buildUnsubscribeMsg: WsUnsubscribeMessage;
  private buildHeartbeatResponse: WsHeartbeatResponse;
  private parseBookUpdate: WsBookParser;

  constructor(
    config: WsOrderBookManagerConfig,
    buildSubscribeMsg: WsSubscribeMessage,
    buildUnsubscribeMsg: WsUnsubscribeMessage,
    buildHeartbeatResponse: WsHeartbeatResponse,
    parseBookUpdate: WsBookParser,
  ) {
    this.config = config;
    this.buildSubscribeMsg = buildSubscribeMsg;
    this.buildUnsubscribeMsg = buildUnsubscribeMsg;
    this.buildHeartbeatResponse = buildHeartbeatResponse;
    this.parseBookUpdate = parseBookUpdate;
    this.log = createChildLogger(`ws:${config.platform}`);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isIntentionalClose = false;

      try {
        this.ws = new WebSocket(this.config.wsUrl);
      } catch (err) {
        return reject(err);
      }

      const timeout = setTimeout(() => {
        reject(new Error(`WebSocket connection timeout for ${this.config.platform}`));
        this.ws?.close();
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        this.log.info('WebSocket connected', { url: this.config.wsUrl });

        // Re-subscribe to any assets we were tracking
        if (this.subscribedAssets.size > 0) {
          this.sendSubscribe(Array.from(this.subscribedAssets));
        }

        // Start heartbeat monitoring
        this.startHeartbeatMonitor();

        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.lastMessageAt = Date.now();
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        this.log.warn('WebSocket closed', {
          code,
          reason: reason?.toString() || 'unknown',
          intentional: this.isIntentionalClose,
        });
        this.stopHeartbeatMonitor();
        if (!this.isIntentionalClose) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.log.error('WebSocket error', { error: err.message });
        eventBus.emit('connector:error', {
          platform: this.config.platform,
          error: err.message,
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isIntentionalClose = true;
    this.stopHeartbeatMonitor();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Intentional disconnect');
      this.ws = null;
    }

    this.books.clear();
    this.subscribedAssets.clear();
    this.assetToMarket.clear();
    this.log.info('WebSocket disconnected');
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  /**
   * Subscribe to order book updates for the given asset IDs.
   * Call with the token/outcome IDs you want to track.
   */
  subscribe(
    assetIds: string[],
    marketMappings: Array<{ assetId: string; marketId: string; outcomeIndex: number }>,
  ): void {
    const newAssets = assetIds.filter(id => !this.subscribedAssets.has(id));
    if (newAssets.length === 0) return;

    // Register mappings
    for (const m of marketMappings) {
      this.assetToMarket.set(m.assetId, { marketId: m.marketId, outcomeIndex: m.outcomeIndex });
    }

    for (const id of newAssets) {
      this.subscribedAssets.add(id);
    }

    if (this.isConnected) {
      this.sendSubscribe(newAssets);
    }

    this.log.info('Subscribed to assets', {
      newAssets: newAssets.length,
      totalSubscribed: this.subscribedAssets.size,
    });
  }

  /**
   * Unsubscribe from asset IDs.
   */
  unsubscribe(assetIds: string[]): void {
    const removing = assetIds.filter(id => this.subscribedAssets.has(id));
    if (removing.length === 0) return;

    for (const id of removing) {
      this.subscribedAssets.delete(id);
      this.books.delete(id);
      this.assetToMarket.delete(id);
    }

    if (this.isConnected) {
      this.sendUnsubscribe(removing);
    }
  }

  // ─── Book Access ───────────────────────────────────────────────────────

  /**
   * Get the latest cached order book for an asset.
   * Returns null if we don't have a book yet (not subscribed or no update received).
   */
  getBook(assetId: string): OrderBook | null {
    return this.books.get(assetId) ?? null;
  }

  /**
   * Get book by market ID and outcome index.
   */
  getBookByMarket(marketId: string, outcomeIndex: number): OrderBook | null {
    for (const [assetId, mapping] of this.assetToMarket.entries()) {
      if (mapping.marketId === marketId && mapping.outcomeIndex === outcomeIndex) {
        return this.books.get(assetId) ?? null;
      }
    }
    return null;
  }

  /**
   * Check if a cached book is fresh (not stale).
   */
  isBookFresh(assetId: string): boolean {
    const book = this.books.get(assetId);
    if (!book) return false;
    return Date.now() - book.timestamp.getTime() < this.config.staleThresholdMs;
  }

  /** Number of assets currently tracked */
  get trackedCount(): number {
    return this.subscribedAssets.size;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private sendSubscribe(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = this.buildSubscribeMsg(assetIds);
    this.ws.send(msg);
    this.log.debug('Sent subscribe', { count: assetIds.length });
  }

  private sendUnsubscribe(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = this.buildUnsubscribeMsg(assetIds);
    this.ws.send(msg);
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const raw = JSON.parse(data.toString());

      // Check if it's a heartbeat that needs a response
      const heartbeatReply = this.buildHeartbeatResponse(raw);
      if (heartbeatReply && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(heartbeatReply);
        return;
      }

      // Try to parse as book update
      // Polymarket sends arrays of events
      const messages = Array.isArray(raw) ? raw : [raw];

      for (const msg of messages) {
        const parsed = this.parseBookUpdate(msg);
        if (parsed) {
          this.applyBookUpdate(parsed);
        }
      }
    } catch {
      // Binary or unparseable messages — ignore
    }
  }

  private applyBookUpdate(update: ParsedBookUpdate): void {
    const bids = update.bids.sort((a, b) => b.price - a.price);
    const asks = update.asks.sort((a, b) => a.price - b.price);
    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;

    const book: OrderBook = {
      platform: this.config.platform,
      marketId: update.marketId,
      outcomeIndex: update.outcomeIndex,
      bids,
      asks,
      minOrderSize: update.minOrderSize ?? 1,
      tickSize: update.tickSize ?? 0.01,
      bestBid,
      bestAsk,
      midPrice: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      timestamp: update.timestamp,
    };

    this.books.set(update.assetId, book);

    // Emit book:update so strategies can react to price changes immediately
    eventBus.emit('book:update', {
      platform: this.config.platform,
      marketId: update.marketId,
      outcomeIndex: update.outcomeIndex,
    });
  }

  // ─── Reconnection ─────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.config.maxReconnects > 0 && this.reconnectAttempts >= this.config.maxReconnects) {
      this.log.error('Max reconnection attempts reached', {
        attempts: this.reconnectAttempts,
      });
      eventBus.emit('connector:disconnected', { platform: this.config.platform });
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts),
      this.config.reconnectMaxDelayMs,
    );

    this.reconnectAttempts++;

    this.log.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        this.log.error('Reconnect failed', { error: (err as Error).message });
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ─── Heartbeat Monitoring ──────────────────────────────────────────────

  private startHeartbeatMonitor(): void {
    if (this.config.heartbeatIntervalMs <= 0) return;
    this.stopHeartbeatMonitor();

    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastMessageAt;
      if (elapsed > this.config.heartbeatIntervalMs * 3) {
        this.log.warn('Heartbeat timeout — no messages received', {
          elapsedMs: elapsed,
          threshold: this.config.heartbeatIntervalMs * 3,
        });
        // Force reconnect
        this.ws?.close(4000, 'Heartbeat timeout');
      }
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
