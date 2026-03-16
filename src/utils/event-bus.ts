// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Event Bus
// Central pub/sub for decoupled communication between components
// ═══════════════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { ArbitrageOpportunity, BotState, OrderResult, TradeRecord } from '../types';

/** All events the system can emit */
export interface BotEvents {
  'bot:state_change': { from: BotState; to: BotState };
  'bot:scan_start': { timestamp: Date };
  'bot:scan_complete': { timestamp: Date; durationMs: number; opportunitiesFound: number };
  'opportunity:found': ArbitrageOpportunity;
  'opportunity:expired': { id: string };
  'trade:pending': TradeRecord;
  'trade:executed': TradeRecord;
  'trade:failed': { tradeId: string; error: string };
  'order:placed': OrderResult;
  'order:filled': OrderResult;
  'order:cancelled': OrderResult;
  'book:update': { platform: string; marketId: string; outcomeIndex: number };
  'connector:connected': { platform: string };
  'connector:disconnected': { platform: string };
  'connector:error': { platform: string; error: string };
  'risk:limit_breach': { type: string; current: number; limit: number };
  'discovery:category_start': { category: string; index: number; total: number; pipeline: 'sports' | 'generic' };
  'discovery:category_complete': { category: string; index: number; total: number; durationMs: number; marketsFound: number; newPairs: number; totalPairs: number };
  'discovery:category_error': { category: string; error: string };
  'discovery:fetch': { platform: string; category: string; marketsFound: number };
  'discovery:matching': { category: string; platformA: string; platformB: string; unmatchedA: number; unmatchedB: number; newPairs: number };
  'discovery:match_pass': { pass: string; pairs: number; remaining: number };
  'dashboard:update': Record<string, unknown>;
}

class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof BotEvents>(event: K, data: BotEvents[K]): void {
    this.emitter.emit(event, data);
  }

  on<K extends keyof BotEvents>(event: K, handler: (data: BotEvents[K]) => void): void {
    this.emitter.on(event, handler);
  }

  off<K extends keyof BotEvents>(event: K, handler: (data: BotEvents[K]) => void): void {
    this.emitter.off(event, handler);
  }

  once<K extends keyof BotEvents>(event: K, handler: (data: BotEvents[K]) => void): void {
    this.emitter.once(event, handler);
  }
}

/** Singleton event bus */
export const eventBus = new TypedEventBus();
