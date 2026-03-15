// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Sports Matcher
// Deterministic sports market matching using team names + game date.
// No fuzzy matching or LLM needed — sports markets are highly structured.
//
// Match key: sorted team names + market type + date + league
// Two markets with the same match key are the same event.
// ═══════════════════════════════════════════════════════════════════════════

import { createChildLogger } from '../utils/logger';
import { MarketPair, PairStatus } from './market-matcher';
import {
  DiscoveredMarket,
  SportsMarketInfo,
  SportsLeague,
  SportsMarketType,
} from '../discovery/types';

const log = createChildLogger('sports-matcher');

// ─── Team Name Normalization ─────────────────────────────────────────────

/** Common team name aliases → canonical name */
const TEAM_ALIASES: Record<string, string> = {
  // NBA
  'sixers': '76ers',
  'philly': '76ers',
  'philadelphia 76ers': '76ers',
  'la lakers': 'lakers',
  'los angeles lakers': 'lakers',
  'la clippers': 'clippers',
  'los angeles clippers': 'clippers',
  'golden state': 'warriors',
  'golden state warriors': 'warriors',
  'san antonio': 'spurs',
  'san antonio spurs': 'spurs',
  'oklahoma city': 'thunder',
  'oklahoma city thunder': 'thunder',
  'new york knicks': 'knicks',
  'new york': 'knicks',
  'brooklyn nets': 'nets',
  'brooklyn': 'nets',
  'boston celtics': 'celtics',
  'boston': 'celtics',
  'miami heat': 'heat',
  'milwaukee bucks': 'bucks',
  'dallas mavericks': 'mavericks',
  'dallas mavs': 'mavericks',
  'denver nuggets': 'nuggets',
  'phoenix suns': 'suns',
  'minnesota timberwolves': 'timberwolves',
  'minnesota': 'timberwolves',
  'indiana pacers': 'pacers',
  'cleveland cavaliers': 'cavaliers',
  'cleveland cavs': 'cavaliers',
  'sacramento kings': 'kings',
  'memphis grizzlies': 'grizzlies',
  'houston rockets': 'rockets',
  'atlanta hawks': 'hawks',
  'chicago bulls': 'bulls',
  'toronto raptors': 'raptors',
  'detroit pistons': 'pistons',
  'orlando magic': 'magic',
  'charlotte hornets': 'hornets',
  'portland trail blazers': 'trail blazers',
  'portland': 'trail blazers',
  'new orleans pelicans': 'pelicans',
  'new orleans': 'pelicans',
  'utah jazz': 'jazz',
  'washington wizards': 'wizards',

  // NFL
  'new england patriots': 'patriots',
  'new england': 'patriots',
  'green bay packers': 'packers',
  'green bay': 'packers',
  'kansas city chiefs': 'chiefs',
  'kansas city': 'chiefs',
  'san francisco 49ers': '49ers',
  'san francisco': '49ers',
  'tampa bay buccaneers': 'buccaneers',
  'tampa bay': 'buccaneers',
  'las vegas raiders': 'raiders',
  'los angeles rams': 'rams',
  'los angeles chargers': 'chargers',
  'jacksonville jaguars': 'jaguars',
  'carolina panthers': 'panthers',
  'arizona cardinals': 'cardinals',
  'new york giants': 'giants',
  'new york jets': 'jets',
  'pittsburgh steelers': 'steelers',
  'baltimore ravens': 'ravens',
  'cincinnati bengals': 'bengals',
  'tennessee titans': 'titans',
  'indianapolis colts': 'colts',
  'seattle seahawks': 'seahawks',
  'buffalo bills': 'bills',
  'denver broncos': 'broncos',
  'minnesota vikings': 'vikings',

  // MLB
  'new york yankees': 'yankees',
  'new york mets': 'mets',
  'boston red sox': 'red sox',
  'chicago cubs': 'cubs',
  'chicago white sox': 'white sox',
  'los angeles dodgers': 'dodgers',
  'los angeles angels': 'angels',
  'san francisco giants': 'sf giants',
  'st louis cardinals': 'stl cardinals',
  'st. louis cardinals': 'stl cardinals',

  // NHL
  'new york rangers': 'rangers',
  'new york islanders': 'islanders',
  'toronto maple leafs': 'maple leafs',
  'tampa bay lightning': 'lightning',
  'vegas golden knights': 'golden knights',
  'los angeles kings': 'la kings',
  'san jose sharks': 'sharks',
  'new jersey devils': 'devils',
  'columbus blue jackets': 'blue jackets',
  'colorado avalanche': 'avalanche',
  'st louis blues': 'blues',
  'st. louis blues': 'blues',
};

/**
 * Normalize a team name for cross-platform comparison.
 * Steps:
 * 1. Lowercase
 * 2. Strip articles ("the")
 * 3. Remove punctuation (apostrophes, periods)
 * 4. Collapse whitespace
 * 5. Look up alias table
 */
export function normalizeTeamName(name: string): string {
  let normalized = name
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[''`.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Check alias table
  if (TEAM_ALIASES[normalized]) {
    normalized = TEAM_ALIASES[normalized];
  }

  return normalized;
}

// ─── Date Extraction ─────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08',
  sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Extract a date from text and normalize to YYYY-MM-DD.
 * Handles:
 * - "March 15, 2026" / "Mar 15 2026"
 * - "3/15/2026" / "3/15"
 * - "2026-03-15"
 * - "03-15" / "03/15"
 */
export function extractDate(text: string): string | null {
  // ISO format: 2026-03-15
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // Named month: "March 15, 2026" or "Mar 15"
  const namedMonthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i;
  const namedMatch = text.match(namedMonthPattern);
  if (namedMatch) {
    const month = MONTH_NAMES[namedMatch[1].toLowerCase()];
    const day = namedMatch[2].padStart(2, '0');
    const year = namedMatch[3] || new Date().getFullYear().toString();
    return `${year}-${month}-${day}`;
  }

  // Numeric: M/D/YYYY or M/D or MM-DD
  const numericMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numericMatch) {
    const month = numericMatch[1].padStart(2, '0');
    const day = numericMatch[2].padStart(2, '0');
    let year = numericMatch[3] || new Date().getFullYear().toString();
    if (year.length === 2) year = `20${year}`;
    // Sanity: month should be 01-12
    if (parseInt(month) >= 1 && parseInt(month) <= 12) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * Extract date from various market data sources.
 * Priority: endDate > question text > slug > ticker
 */
export function extractGameDate(market: DiscoveredMarket): string | null {
  // 1. From endDate if available (most reliable)
  if (market.endDate) {
    const d = new Date(market.endDate);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // 2. From ticker (Kalshi: KXNBAGAME-26MAR14-BOS-LAL style)
  if (market.platform === 'kalshi') {
    const raw = market.raw as Record<string, unknown>;
    const ticker = (raw?.ticker as string) || market.id;
    const tickerDate = extractDateFromKalshiTicker(ticker);
    if (tickerDate) return tickerDate;
  }

  // 3. From question text
  const fromQuestion = extractDate(market.question);
  if (fromQuestion) return fromQuestion;

  // 4. From slug
  const fromSlug = extractDate(market.slug.replace(/-/g, ' '));
  if (fromSlug) return fromSlug;

  return null;
}

/**
 * Extract date from Kalshi ticker format.
 * Tickers often embed dates: KXNBAGAME-26MAR14-BOS-LAL
 * or just event_ticker patterns with dates.
 */
function extractDateFromKalshiTicker(ticker: string): string | null {
  // Pattern: -YYMMMDD- (e.g., -26MAR14-)
  const tickerMatch = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (tickerMatch) {
    const year = `20${tickerMatch[1]}`;
    const month = MONTH_NAMES[tickerMatch[2].toLowerCase()];
    const day = tickerMatch[3].padStart(2, '0');
    if (month) return `${year}-${month}-${day}`;
  }
  return null;
}

// ─── League Detection ────────────────────────────────────────────────────

const LEAGUE_PATTERNS: Array<[RegExp, SportsLeague]> = [
  [/\bNBA\b/i, 'NBA'],
  [/\bNFL\b/i, 'NFL'],
  [/\bMLB\b/i, 'MLB'],
  [/\bNHL\b/i, 'NHL'],
  [/\bMLS\b/i, 'MLS'],
  [/\bUFC\b/i, 'UFC'],
  [/\bMMA\b/i, 'UFC'],
  [/\bNCAAB\b/i, 'NCAAB'],
  [/\bNCAA\s*basketball\b/i, 'NCAAB'],
  [/\bNCAA(?:F|\s*football)\b/i, 'NCAAF'],
  [/\bEPL\b/i, 'EPL'],
  [/\bPremier\s*League\b/i, 'EPL'],
  [/\bLa\s*Liga\b/i, 'LIGA'],
  [/\bBundesliga\b/i, 'BUNDESLIGA'],
  [/\bSerie\s*A\b/i, 'SERIEA'],
  [/\bChampions\s*League\b/i, 'CHAMPIONS_LEAGUE'],
  [/\btennis\b/i, 'TENNIS'],
  [/\bgolf\b/i, 'GOLF'],
  [/\bFormula\s*1\b|\bF1\b/i, 'F1'],
  [/\bboxing\b/i, 'BOXING'],
  [/\bcricket\b/i, 'CRICKET'],
  // Generic patterns for context clues
  [/\bbasketball\b/i, 'NBA'],
  [/\bfootball\b/i, 'NFL'],
  [/\bbaseball\b/i, 'MLB'],
  [/\bhockey\b/i, 'NHL'],
  [/\bsoccer\b/i, 'MLS'],
];

/** Detect sports league from text (question + category + slug) */
export function detectLeague(question: string, category: string, slug: string): SportsLeague {
  const combined = `${question} ${category} ${slug}`;
  for (const [pattern, league] of LEAGUE_PATTERNS) {
    if (pattern.test(combined)) return league;
  }
  return 'UNKNOWN';
}

// ─── Team Extraction ─────────────────────────────────────────────────────

/** Regex patterns for extracting team names from market questions */
const VS_PATTERN = /(.+?)\s+(?:vs\.?|v\.?|versus|at|@)\s+(.+?)(?:\s+[-–]\s+|\s+(?:on|in)\s+|\?|$)/i;
const WIN_BEAT_PATTERN = /(?:will\s+)?(?:the\s+)?(.+?)\s+(?:win|beat|defeat|over)\s+(?:the\s+)?(.+?)(?:\s+(?:on|in)\s+|\?|$)/i;
const KALSHI_TICKER_TEAMS = /^KX\w+GAME-\d{2}[A-Z]{3}\d{2}-([A-Z]{2,4})-([A-Z]{2,4})$/i;

/** Known Kalshi team abbreviations → full team name */
const KALSHI_TEAM_ABBREVS: Record<string, string> = {
  // NBA
  ATL: 'hawks', BOS: 'celtics', BKN: 'nets', CHA: 'hornets',
  CHI: 'bulls', CLE: 'cavaliers', DAL: 'mavericks', DEN: 'nuggets',
  DET: 'pistons', GSW: 'warriors', GS: 'warriors', HOU: 'rockets',
  IND: 'pacers', LAC: 'clippers', LAL: 'lakers', MEM: 'grizzlies',
  MIA: 'heat', MIL: 'bucks', MIN: 'timberwolves', NOP: 'pelicans',
  NO: 'pelicans', NYK: 'knicks', NY: 'knicks', OKC: 'thunder',
  ORL: 'magic', PHI: '76ers', PHX: 'suns', POR: 'trail blazers',
  SAC: 'kings', SAS: 'spurs', SA: 'spurs', TOR: 'raptors',
  UTA: 'jazz', WAS: 'wizards',
  // NFL
  ARI: 'cardinals', BAL: 'ravens', BUF: 'bills', CAR: 'panthers',
  CIN: 'bengals', GB: 'packers', HO: 'texans', JAX: 'jaguars',
  KC: 'chiefs', LV: 'raiders', LAR: 'rams', NE: 'patriots',
  NYG: 'giants', NYJ: 'jets', PIT: 'steelers', SEA: 'seahawks',
  SF: '49ers', TB: 'buccaneers', TEN: 'titans', WAS_NFL: 'commanders',
  // MLB
  STL: 'stl cardinals', SD: 'padres', TEX: 'rangers', COL: 'rockies',
  MIL_MLB: 'brewers', CWS: 'white sox', OAK: 'athletics',
  // NHL
  VGK: 'golden knights', VAN: 'canucks', WPG: 'jets',
  CBJ: 'blue jackets', FLA: 'panthers',
};

/** Extract team pair from a Kalshi ticker */
function extractTeamsFromKalshiTicker(ticker: string): [string, string] | null {
  const match = ticker.match(KALSHI_TICKER_TEAMS);
  if (match) {
    const teamA = KALSHI_TEAM_ABBREVS[match[1].toUpperCase()] || match[1].toLowerCase();
    const teamB = KALSHI_TEAM_ABBREVS[match[2].toUpperCase()] || match[2].toLowerCase();
    return [teamA, teamB];
  }
  return null;
}

/** Extract team pair from a question/title string */
function extractTeamsFromQuestion(question: string): [string, string] | null {
  // "Will X beat/defeat Y"
  const winMatch = question.match(WIN_BEAT_PATTERN);
  if (winMatch) {
    return [
      normalizeTeamName(winMatch[1]),
      normalizeTeamName(winMatch[2]),
    ];
  }

  // "X vs Y"
  const vsMatch = question.match(VS_PATTERN);
  if (vsMatch) {
    return [
      normalizeTeamName(vsMatch[1].replace(/^will\s+(?:the\s+)?/i, '')),
      normalizeTeamName(vsMatch[2]),
    ];
  }

  return null;
}

// ─── Sports Info Parsing ─────────────────────────────────────────────────

/** Market type detection */
function detectMarketType(question: string): SportsMarketType {
  const q = question.toLowerCase();
  if (/over|under|total|o\/u/i.test(q)) return 'over_under';
  if (/spread|handicap|points?\s*line/i.test(q)) return 'spread';
  return 'moneyline';
}

/**
 * Parse a market into SportsMarketInfo.
 * Uses platform-specific data sources for maximum reliability:
 * - Kalshi: ticker parsing first (structured), fallback to title
 * - Polymarket: question text + slug
 * - predict.fun: question text + variantData
 */
export function parseSportsMarket(market: DiscoveredMarket): SportsMarketInfo | null {
  let teams: [string, string] | null = null;
  let gameDate: string | null = null;

  // ── Platform-specific extraction ──────────────────────────────────────

  if (market.platform === 'kalshi') {
    const raw = market.raw as Record<string, unknown>;
    const ticker = (raw?.ticker as string) || market.id;

    // Try ticker-based extraction first (most reliable for Kalshi)
    teams = extractTeamsFromKalshiTicker(ticker);
    gameDate = extractDateFromKalshiTicker(ticker);
  }

  // ── Generic extraction from question text ─────────────────────────────

  if (!teams) {
    teams = extractTeamsFromQuestion(market.question);
  }

  if (!gameDate) {
    gameDate = extractGameDate(market);
  }

  // ── Can't match without teams ─────────────────────────────────────────

  if (!teams) {
    return null;
  }

  const league = detectLeague(market.question, market.category, market.slug);
  const marketType = detectMarketType(market.question);

  // Sort teams alphabetically so "A vs B" == "B vs A"
  const [sortedA, sortedB] = [teams[0], teams[1]].sort();

  // Build deterministic match key
  const keyParts = [`${sortedA}|${sortedB}`, marketType];
  if (gameDate) keyParts.push(gameDate);
  if (league !== 'UNKNOWN') keyParts.push(league);
  const matchKey = keyParts.join('::');

  return {
    teamA: sortedA,
    teamB: sortedB,
    gameDate,
    league,
    marketType,
    matchKey,
  };
}

// ─── Sports Matcher ──────────────────────────────────────────────────────

/**
 * Deterministic sports market matcher.
 * Matches markets by their sports match key (teams + date + league + type).
 *
 * Algorithm:
 * 1. Parse all markets into SportsMarketInfo
 * 2. Index markets from side A by matchKey
 * 3. For each market in side B, look up by matchKey
 * 4. Return matched pairs with confidence 1.0
 *
 * Complexity: O(n + m) where n = |marketsA|, m = |marketsB|
 */
export class SportsMatcher {
  /** Optional pair status overrides (from DB) */
  private pairStatuses = new Map<string, PairStatus>();

  /** Load persisted pair statuses */
  loadPairStatuses(statuses: Map<string, PairStatus>): void {
    for (const [id, status] of statuses) {
      this.pairStatuses.set(id, status);
    }
  }

  /** Reset all state */
  reset(): void {
    this.pairStatuses.clear();
  }

  /**
   * Match sports markets between two platforms.
   * Returns matched pairs with confidence 1.0, auto-approved.
   *
   * Also attempts date-relaxed matching: if exact match key fails,
   * tries matching with ±1 day tolerance (handles timezone differences).
   */
  match(
    marketsA: DiscoveredMarket[],
    marketsB: DiscoveredMarket[],
  ): MarketPair[] {
    const startMs = Date.now();
    const pairs: MarketPair[] = [];
    const usedA = new Set<string>();
    const usedB = new Set<string>();

    // ── Step 1: Parse all markets ───────────────────────────────────────

    const parsedA = new Map<string, { market: DiscoveredMarket; info: SportsMarketInfo }>();
    const parsedB = new Map<string, { market: DiscoveredMarket; info: SportsMarketInfo }>();
    let parseFailA = 0, parseFailB = 0;

    for (const m of marketsA) {
      const info = m.sportsInfo || parseSportsMarket(m);
      if (info) {
        parsedA.set(m.id, { market: m, info });
      } else {
        parseFailA++;
      }
    }

    for (const m of marketsB) {
      const info = m.sportsInfo || parseSportsMarket(m);
      if (info) {
        parsedB.set(m.id, { market: m, info });
      } else {
        parseFailB++;
      }
    }

    log.info('Parsed sports markets', {
      sideA: { total: marketsA.length, parsed: parsedA.size, failed: parseFailA },
      sideB: { total: marketsB.length, parsed: parsedB.size, failed: parseFailB },
    });

    // ── Step 2: Build index from side A by matchKey ─────────────────────

    const indexA = new Map<string, { market: DiscoveredMarket; info: SportsMarketInfo }>();
    for (const [id, entry] of parsedA) {
      // Use the full matchKey (includes date)
      if (!indexA.has(entry.info.matchKey)) {
        indexA.set(entry.info.matchKey, entry);
      }
    }

    // Also build a date-relaxed index for ±1 day matching
    const dateRelaxedA = new Map<string, { market: DiscoveredMarket; info: SportsMarketInfo }>();
    for (const [id, entry] of parsedA) {
      // Key without date for date-relaxed matching
      const relaxedKey = this.buildDateRelaxedKey(entry.info);
      if (relaxedKey && !dateRelaxedA.has(relaxedKey)) {
        dateRelaxedA.set(relaxedKey, entry);
      }
    }

    // ── Step 3: Match from side B ───────────────────────────────────────

    for (const [idB, entryB] of parsedB) {
      if (usedB.has(idB)) continue;

      // Exact match key lookup
      const exactMatch = indexA.get(entryB.info.matchKey);
      if (exactMatch && !usedA.has(exactMatch.market.id)) {
        pairs.push(this.createPair(exactMatch.market, entryB.market, 1.0, exactMatch.info, entryB.info));
        usedA.add(exactMatch.market.id);
        usedB.add(idB);
        continue;
      }

      // Date-relaxed match (handles timezone differences between platforms)
      const relaxedKey = this.buildDateRelaxedKey(entryB.info);
      if (relaxedKey) {
        const relaxedMatch = dateRelaxedA.get(relaxedKey);
        if (relaxedMatch && !usedA.has(relaxedMatch.market.id)) {
          // Verify dates are within ±1 day
          if (this.datesWithinRange(relaxedMatch.info.gameDate, entryB.info.gameDate, 1)) {
            pairs.push(this.createPair(relaxedMatch.market, entryB.market, 0.95, relaxedMatch.info, entryB.info));
            usedA.add(relaxedMatch.market.id);
            usedB.add(idB);
          }
        }
      }
    }

    const durationMs = Date.now() - startMs;
    log.info('Sports matching complete', {
      matched: pairs.length,
      unmatchedA: parsedA.size - usedA.size,
      unmatchedB: parsedB.size - usedB.size,
      durationMs,
    });

    return pairs;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Build a match key without the date component (for date-relaxed matching) */
  private buildDateRelaxedKey(info: SportsMarketInfo): string | null {
    if (!info.gameDate) return null;
    const parts = [`${info.teamA}|${info.teamB}`, info.marketType];
    if (info.league !== 'UNKNOWN') parts.push(info.league);
    return parts.join('::');
  }

  /** Check if two dates are within N days of each other */
  private datesWithinRange(dateA: string | null, dateB: string | null, days: number): boolean {
    if (!dateA || !dateB) return true; // Can't compare, assume OK
    try {
      const a = new Date(dateA).getTime();
      const b = new Date(dateB).getTime();
      return Math.abs(a - b) <= days * 24 * 60 * 60 * 1000;
    } catch {
      return true;
    }
  }

  /** Generate a deterministic pair ID from two market IDs */
  private pairId(idA: string, idB: string): string {
    const [first, second] = [idA, idB].sort();
    return `${first}::${second}`;
  }

  /** Create a MarketPair from two matched sports markets */
  private createPair(
    marketA: DiscoveredMarket,
    marketB: DiscoveredMarket,
    confidence: number,
    infoA: SportsMarketInfo,
    infoB: SportsMarketInfo,
  ): MarketPair {
    const pairId = this.pairId(marketA.id, marketB.id);
    return {
      pairId,
      marketA,
      marketB,
      confidence,
      matchMethod: 'sports_normalized',
      status: this.pairStatuses.get(pairId) || 'approved', // Sports matches are auto-approved
    };
  }
}
