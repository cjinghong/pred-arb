// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Discovery Types
// Types for category-aware market discovery and matching.
// Each category (sports, politics, crypto, etc.) has its own discovery
// and matching logic, optimized for that domain.
// ═══════════════════════════════════════════════════════════════════════════

import { NormalizedMarket, Platform } from '../types';

/** Supported market categories — each has custom discovery + matching logic */
export type MarketCategory = 'sports' | 'politics' | 'crypto';

// ─── Sports ──────────────────────────────────────────────────────────────

/** Supported sports leagues */
export type SportsLeague =
  | 'NBA' | 'NFL' | 'MLB' | 'NHL' | 'MLS'
  | 'UFC' | 'NCAA' | 'NCAAB' | 'NCAAF'
  | 'EPL' | 'LIGA' | 'BUNDESLIGA' | 'SERIEA' | 'CHAMPIONS_LEAGUE'
  | 'TENNIS' | 'GOLF' | 'F1' | 'BOXING' | 'CRICKET'
  | 'UNKNOWN';

/** Sports market type (betting market type, not platform type) */
export type SportsMarketType = 'moneyline' | 'spread' | 'over_under';

/** Extracted sports metadata attached to a discovered market */
export interface SportsMarketInfo {
  /** Normalized team A name (alphabetically first) */
  teamA: string;
  /** Normalized team B name (alphabetically second) */
  teamB: string;
  /** Game date in YYYY-MM-DD format */
  gameDate: string | null;
  /** Detected league */
  league: SportsLeague;
  /** Market type (moneyline = who wins, spread, over/under) */
  marketType: SportsMarketType;
  /**
   * Deterministic match key for cross-platform matching.
   * Format: `${sortedTeamA}|${sortedTeamB}::${marketType}::${date}::${league}`
   * Two markets with the same matchKey are the same event.
   */
  matchKey: string;
  /**
   * Which team outcome 0 (YES) represents on this market.
   * Critical for cross-platform outcome alignment:
   * - Polymarket: YES = first listed team in outcomes array (e.g., "Suns" in ["Suns", "Celtics"])
   * - Kalshi: YES = the team in the market ticker (e.g., PHX in KXNBAGAME-26MAR16PHXBOS-PHX)
   * - predict.fun: YES = first listed team
   * If two matched markets have different yesTeam values, outcomes are inverted.
   */
  yesTeam?: string;
  /** Raw yesTeam value before league-aware normalization (for diagnostics) */
  yesTeamRaw?: string;
}

/** A market enriched with category-specific metadata */
export interface DiscoveredMarket extends NormalizedMarket {
  /** Sports-specific info (only present for sports markets) */
  sportsInfo?: SportsMarketInfo;
}

/** Options for sports-specific market discovery */
export interface SportsFetchOptions {
  /** Which specific league to fetch (e.g., 'NBA'). If not set, fetches all sports. */
  league?: SportsLeague;
  /** How many days ahead to look for events (default: 3) */
  lookAheadDays?: number;
  /** Maximum results per platform (default: 1000) */
  maxResults?: number;
}

// ─── Kalshi Series Ticker Mapping ────────────────────────────────────────
// Kalshi uses `series_ticker` to identify sports leagues.
// Format: GET /markets?series_ticker=KXNBAGAME&status=open&min_end_timestamp=...

export const KALSHI_SERIES_TICKERS: Record<string, string> = {
  NBA: 'KXNBAGAME',
  NFL: 'KXNFLGAME',
  MLB: 'KXMLBGAME',
  NHL: 'KXNHLGAME',
  MLS: 'KXMLSGAME',
  NCAAB: 'KXNCAABGAME',
  NCAAF: 'KXNCAAFGAME',
  UFC: 'KXUFCFIGHT',
};

// ─── Polymarket Sports Tag Mapping ───────────────────────────────────────
// Polymarket's Gamma API uses `tag` slugs + `sports_market_types=moneyline`
// for targeted sports queries with date filtering.

export const POLYMARKET_SPORTS_TAGS: Record<string, string> = {
  NBA: 'nba',
  NFL: 'nfl',
  MLB: 'mlb',
  NHL: 'nhl',
  MLS: 'soccer',
  NCAAB: 'ncaa-basketball',
  NCAAF: 'ncaa',
  UFC: 'ufc',
  TENNIS: 'tennis',
  GOLF: 'golf',
  F1: 'formula-1',
  BOXING: 'boxing',
  CRICKET: 'cricket',
  // Generic sports tag covers all
  ALL: 'sports',
};

// ─── predict.fun Sports Mapping ──────────────────────────────────────────
// predict.fun uses marketVariant=SPORTS_MATCH or SPORTS_TEAM_MATCH
// and categorySlug for league-level filtering.

export const PREDICTFUN_SPORTS_SLUGS: Record<string, string[]> = {
  NBA: ['basketball', 'nba'],
  NFL: ['football', 'nfl'],
  MLB: ['baseball', 'mlb'],
  NHL: ['hockey', 'nhl'],
  MLS: ['soccer', 'mls'],
  NCAA: ['ncaa'],
  UFC: ['mma', 'ufc'],
  TENNIS: ['tennis'],
  GOLF: ['golf'],
  F1: ['motorsports', 'f1'],
  BOXING: ['boxing'],
  CRICKET: ['cricket'],
};

// ─── Category Discovery Interface ───────────────────────────────────────

/** Result of a discovery run — markets grouped by platform */
export interface DiscoveryResult {
  markets: Map<Platform, DiscoveredMarket[]>;
  /** How long the discovery took (ms) */
  durationMs: number;
  /** Summary stats for logging */
  stats: {
    totalMarkets: number;
    byPlatform: Record<string, number>;
    byLeague: Record<string, number>;
    parsedSuccessfully: number;
    parseFailures: number;
  };
}
