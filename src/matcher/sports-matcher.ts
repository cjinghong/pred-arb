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
  'los angeles l': 'lakers',       // Kalshi disambiguation initial
  'la clippers': 'clippers',
  'los angeles clippers': 'clippers',
  'los angeles c': 'clippers',     // Kalshi disambiguation initial
  'golden state': 'warriors',
  'golden state warriors': 'warriors',
  'san antonio': 'spurs',
  'san antonio spurs': 'spurs',
  'oklahoma city': 'thunder',
  'oklahoma city thunder': 'thunder',
  'new york knicks': 'knicks',
  'new york k': 'knicks',          // Kalshi disambiguation initial
  'new york': 'knicks',
  'brooklyn nets': 'nets',
  'brooklyn': 'nets',
  'boston celtics': 'celtics',
  'boston': 'celtics',
  'miami heat': 'heat',
  'miami': 'heat',
  'milwaukee bucks': 'bucks',
  'milwaukee': 'bucks',
  'dallas mavericks': 'mavericks',
  'dallas mavs': 'mavericks',
  'dallas': 'mavericks',
  'denver nuggets': 'nuggets',
  'denver': 'nuggets',
  'phoenix suns': 'suns',
  'phoenix': 'suns',
  'minnesota timberwolves': 'timberwolves',
  'minnesota': 'timberwolves',
  'indiana pacers': 'pacers',
  'indiana': 'pacers',
  'cleveland cavaliers': 'cavaliers',
  'cleveland cavs': 'cavaliers',
  'cleveland': 'cavaliers',
  'sacramento kings': 'kings',
  'sacramento': 'kings',
  'memphis grizzlies': 'grizzlies',
  'memphis': 'grizzlies',
  'houston rockets': 'rockets',
  'houston': 'rockets',
  'atlanta hawks': 'hawks',
  'atlanta': 'hawks',
  'chicago bulls': 'bulls',
  'chicago': 'bulls',
  'toronto raptors': 'raptors',
  'toronto': 'raptors',
  'detroit pistons': 'pistons',
  'detroit': 'pistons',
  'orlando magic': 'magic',
  'orlando': 'magic',
  'charlotte hornets': 'hornets',
  'charlotte': 'hornets',
  'portland trail blazers': 'trail blazers',
  'portland': 'trail blazers',
  'new orleans pelicans': 'pelicans',
  'new orleans': 'pelicans',
  'utah jazz': 'jazz',
  'utah': 'jazz',
  'washington wizards': 'wizards',
  'washington': 'wizards',

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
  'new york g': 'giants',           // Kalshi disambiguation initial
  'new york jets': 'jets',
  'new york j': 'jets',             // Kalshi disambiguation initial
  'pittsburgh steelers': 'steelers',
  'pittsburgh': 'steelers',
  'baltimore ravens': 'ravens',
  'baltimore': 'ravens',
  'cincinnati bengals': 'bengals',
  'cincinnati': 'bengals',
  'tennessee titans': 'titans',
  'tennessee': 'titans',
  'indianapolis colts': 'colts',
  'indianapolis': 'colts',
  'seattle seahawks': 'seahawks',
  'seattle': 'seahawks',
  'buffalo bills': 'bills',
  'buffalo': 'bills',
  'denver broncos': 'broncos',
  'minnesota vikings': 'vikings',
  'jacksonville': 'jaguars',
  'carolina': 'panthers',
  'arizona': 'cardinals',

  // MLB
  'new york yankees': 'yankees',
  'new york y': 'yankees',          // Kalshi disambiguation initial
  'new york mets': 'mets',
  'new york m': 'mets',             // Kalshi disambiguation initial
  'boston red sox': 'red sox',
  'chicago cubs': 'cubs',
  'chicago c': 'cubs',              // Kalshi disambiguation initial
  'chicago white sox': 'white sox',
  'chicago w': 'white sox',         // Kalshi disambiguation initial
  'los angeles dodgers': 'dodgers',
  'los angeles d': 'dodgers',       // Kalshi disambiguation initial
  'los angeles angels': 'angels',
  'los angeles a': 'angels',        // Kalshi disambiguation initial
  'san francisco giants': 'sf giants',
  'st louis cardinals': 'stl cardinals',
  'st. louis cardinals': 'stl cardinals',
  'st louis': 'stl cardinals',

  // NHL
  'new york rangers': 'rangers',
  'new york r': 'rangers',          // Kalshi disambiguation initial
  'new york islanders': 'islanders',
  'new york i': 'islanders',        // Kalshi disambiguation initial
  'toronto maple leafs': 'maple leafs',
  'tampa bay lightning': 'lightning',
  'vegas golden knights': 'golden knights',
  'vegas': 'golden knights',
  'los angeles kings': 'la kings',
  'san jose sharks': 'sharks',
  'san jose': 'sharks',
  'new jersey devils': 'devils',
  'new jersey': 'devils',
  'columbus blue jackets': 'blue jackets',
  'columbus': 'blue jackets',
  'colorado avalanche': 'avalanche',
  'colorado': 'avalanche',
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

  // Strip common Kalshi suffixes: "Winner", "Winning", etc.
  normalized = normalized
    .replace(/\s+winner$/i, '')
    .replace(/\s+winning$/i, '')
    .replace(/\s+win$/i, '')
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
  // Kalshi series ticker patterns (e.g., KXNBAGAME in ticker/slug/id)
  [/NBAGAME/i, 'NBA'],
  [/NFLGAME/i, 'NFL'],
  [/MLBGAME/i, 'MLB'],
  [/NHLGAME/i, 'NHL'],
  [/MLSGAME/i, 'MLS'],
  [/UFCFIGHT/i, 'UFC'],
  // Polymarket slug prefixes (e.g., "nba-lal-hou-2026-03-16")
  [/^nba-/i, 'NBA'],
  [/^nfl-/i, 'NFL'],
  [/^mlb-/i, 'MLB'],
  [/^nhl-/i, 'NHL'],
  [/^mls-/i, 'MLS'],
  [/^ufc-/i, 'UFC'],
  [/^ncaab-/i, 'NCAAB'],
  [/^ncaaf-/i, 'NCAAF'],
  [/^epl-/i, 'EPL'],
  // Generic patterns for context clues
  [/\bbasketball\b/i, 'NBA'],
  [/\bfootball\b/i, 'NFL'],
  [/\bbaseball\b/i, 'MLB'],
  [/\bhockey\b/i, 'NHL'],
  [/\bsoccer\b/i, 'MLS'],
];

/**
 * Detect sports league from text (question + category + slug + optional market ID).
 * Checks question, category, slug, and market ID for league indicators.
 * Kalshi tickers embed the league (e.g., KXNBAGAME-26MAR16PHXBOS-PHX)
 * Polymarket slugs start with the league (e.g., nba-phx-bos-2026-03-16)
 */
export function detectLeague(question: string, category: string, slug: string, marketId?: string): SportsLeague {
  // Check each source individually to handle patterns that need start-of-string matching (like ^nba-)
  const sources = [question, category, slug];
  if (marketId) sources.push(marketId);

  for (const [pattern, league] of LEAGUE_PATTERNS) {
    for (const source of sources) {
      if (pattern.test(source)) return league;
    }
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

/**
 * Short team ID → canonical team name.
 * Used for Polymarket slug parsing (e.g., "nba-cle-det-2025-10-27" → cle → cavaliers).
 * These are lowercase abbreviations commonly found in slugs/URLs.
 */
const TEAM_ID_TO_NAME: Record<string, string> = {
  // NBA
  atl: 'hawks', bos: 'celtics', bkn: 'nets', cha: 'hornets',
  chi: 'bulls', cle: 'cavaliers', dal: 'mavericks', den: 'nuggets',
  det: 'pistons', gsw: 'warriors', gs: 'warriors', hou: 'rockets',
  ind: 'pacers', lac: 'clippers', lal: 'lakers', mem: 'grizzlies',
  mia: 'heat', mil: 'bucks', min: 'timberwolves', nop: 'pelicans',
  no: 'pelicans', nyk: 'knicks', ny: 'knicks', okc: 'thunder',
  orl: 'magic', phi: '76ers', phx: 'suns', por: 'trail blazers',
  sac: 'kings', sas: 'spurs', sa: 'spurs', tor: 'raptors',
  uta: 'jazz', was: 'wizards',
  // NFL
  ari: 'cardinals', bal: 'ravens', buf: 'bills', car: 'panthers',
  cin: 'bengals', gb: 'packers', hou_nfl: 'texans', jax: 'jaguars',
  kc: 'chiefs', lv: 'raiders', lar: 'rams', ne: 'patriots',
  nyg: 'giants', nyj: 'jets', pit: 'steelers', sea: 'seahawks',
  sf: '49ers', tb: 'buccaneers', ten: 'titans',
  // MLB
  stl: 'stl cardinals', sd: 'padres', tex: 'rangers', col: 'rockies',
  cws: 'white sox', oak: 'athletics',
  // NHL
  vgk: 'golden knights', van: 'canucks', wpg: 'jets',
  cbj: 'blue jackets', fla: 'panthers',
};

/** All known Kalshi team abbreviation strings (uppercase), sorted longest first for greedy matching */
const KALSHI_TEAM_ABBREV_LIST: string[] = Object.keys(KALSHI_TEAM_ABBREVS).sort(
  (a, b) => b.length - a.length,
);

/**
 * Extract team pair from a Kalshi ticker using the concatenated format.
 *
 * Kalshi tickers look like: KXNBAGAME-25OCT28LACGSW-LAC
 *   - Parts split by '-': [KXNBAGAME, 25OCT28LACGSW, LAC]
 *   - Middle segment: first 7 chars = date (YYMMMDD), rest = concatenated team abbrevs
 *   - Last segment = team_a abbreviation
 *   - team_b = strip team_a from the concatenated portion
 *
 * Also handles the simpler dash-separated format: KXNBAGAME-26MAR14-BOS-LAL
 */
function extractTeamsFromKalshiTicker(ticker: string): [string, string] | null {
  const parts = ticker.split('-');
  if (parts.length < 2) return null;

  // Try simpler dash-separated format first: PREFIX-DATE-TEAM1-TEAM2
  if (parts.length >= 4) {
    const maybeTeamA = parts[parts.length - 2].toUpperCase();
    const maybeTeamB = parts[parts.length - 1].toUpperCase();
    if (KALSHI_TEAM_ABBREVS[maybeTeamA] && KALSHI_TEAM_ABBREVS[maybeTeamB]) {
      return [KALSHI_TEAM_ABBREVS[maybeTeamA], KALSHI_TEAM_ABBREVS[maybeTeamB]];
    }
  }

  // Concatenated format with hint: KXNBAGAME-25OCT28LACGSW-LAC (3+ parts)
  // Last segment = team_a hint, middle segment = date + concatenated teams
  if (parts.length >= 3) {
    const lastSegment = parts[parts.length - 1].toUpperCase();
    const middleSegment = parts[parts.length - 2].toUpperCase();

    // Last segment is team_a
    const teamAName = KALSHI_TEAM_ABBREVS[lastSegment];
    if (teamAName) {
      // Middle segment: first 7 chars are date (YYMMMDD), rest is concatenated teams
      if (middleSegment.length > 7) {
        const teamsConcat = middleSegment.slice(7);

        // Strip team_a abbreviation from the concatenated portion to get team_b
        if (teamsConcat.startsWith(lastSegment)) {
          const teamBAbbrStr = teamsConcat.slice(lastSegment.length);
          const teamBName = KALSHI_TEAM_ABBREVS[teamBAbbrStr];
          if (teamBName) return [teamAName, teamBName];
        }
        if (teamsConcat.endsWith(lastSegment)) {
          const teamBAbbrStr = teamsConcat.slice(0, teamsConcat.length - lastSegment.length);
          const teamBName = KALSHI_TEAM_ABBREVS[teamBAbbrStr];
          if (teamBName) return [teamAName, teamBName];
        }
        // Brute-force: try all known abbreviation combos
        const foundTeams = findTeamsInConcat(teamsConcat, lastSegment);
        if (foundTeams) return foundTeams;
      }
    }
  }

  // 2-part format (no hint): KXNBAGAME-26MAR16LALHOU
  // Second part = date (7 chars) + concatenated teams (no trailing hint segment)
  if (parts.length >= 2) {
    const segment = parts[parts.length - 1].toUpperCase();
    if (segment.length > 7) {
      const teamsConcat = segment.slice(7); // e.g., "LALHOU" from "26MAR16LALHOU"
      const found = splitConcatTeams(teamsConcat);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Try to find two team abbreviations in a concatenated string when one team is known.
 * Uses greedy longest-match against known Kalshi abbreviations.
 */
function findTeamsInConcat(concat: string, knownTeam: string): [string, string] | null {
  const knownName = KALSHI_TEAM_ABBREVS[knownTeam];
  if (!knownName) return null;

  // Try each known abbreviation as the other team
  for (const abbrev of KALSHI_TEAM_ABBREV_LIST) {
    if (abbrev === knownTeam) continue;
    if (concat === knownTeam + abbrev || concat === abbrev + knownTeam) {
      const otherName = KALSHI_TEAM_ABBREVS[abbrev];
      if (otherName) return [knownName, otherName];
    }
  }
  return null;
}

/**
 * Split a concatenated team string into two teams with no hint.
 * Tries all possible split points against known abbreviations (longest-first).
 * e.g., "LALHOU" → LAL + HOU → [lakers, rockets]
 */
function splitConcatTeams(concat: string): [string, string] | null {
  // Try each known abbreviation as team A (prefix)
  for (const abbrA of KALSHI_TEAM_ABBREV_LIST) {
    if (!concat.startsWith(abbrA)) continue;
    const remainder = concat.slice(abbrA.length);
    const teamBName = KALSHI_TEAM_ABBREVS[remainder];
    if (teamBName) {
      return [KALSHI_TEAM_ABBREVS[abbrA], teamBName];
    }
  }
  return null;
}

/**
 * Extract team pair + date from a Polymarket slug.
 *
 * Polymarket sports slugs follow the pattern:
 *   {league}-{team1}-{team2}-{year}-{month}-{day}
 * e.g., "nba-cle-det-2025-10-27" → teams: cle, det, date: 2025-10-27
 *
 * Returns { teams, date } or null if the slug doesn't match.
 */
function extractFromPolymarketSlug(slug: string): { teams: [string, string]; date: string | null } | null {
  if (!slug) return null;
  const parts = slug.toLowerCase().split('-');

  // Minimum: league + team1 + team2 = 3 parts
  if (parts.length < 3) return null;

  // Check if the first part is a known league prefix
  const leaguePrefixes = new Set([
    'nba', 'nfl', 'mlb', 'nhl', 'mls', 'ncaab', 'ncaaf',
    'epl', 'liga', 'bundesliga', 'seriea', 'ucl', 'ufc',
  ]);

  if (!leaguePrefixes.has(parts[0])) return null;

  // Try to extract date from the tail: check if last 3 parts form YYYY-MM-DD
  // Also handles trailing suffixes like "nba-phx-bos-2026-03-16-phx" or "nba-por-bkn-2026-03-16-draw"
  let date: string | null = null;
  let teamEndIdx = parts.length;

  // Try date at different positions (handles trailing team/type suffixes)
  for (let offset = 0; offset <= 2 && parts.length >= 6 + offset; offset++) {
    const yearIdx = parts.length - 3 - offset;
    const yearCandidate = parts[yearIdx];
    const monthCandidate = parts[yearIdx + 1];
    const dayCandidate = parts[yearIdx + 2];

    if (
      /^\d{4}$/.test(yearCandidate) &&
      /^\d{1,2}$/.test(monthCandidate) &&
      /^\d{1,2}$/.test(dayCandidate)
    ) {
      const m = parseInt(monthCandidate);
      const d = parseInt(dayCandidate);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        date = `${yearCandidate}-${monthCandidate.padStart(2, '0')}-${dayCandidate.padStart(2, '0')}`;
        teamEndIdx = yearIdx;
        break;
      }
    }
  }

  // Teams are parts[1] through teamEndIdx-1
  // Most common: exactly 2 team ID parts (parts[1] and parts[2])
  // But some team IDs might be multi-part (e.g., "golden-state" — unlikely in slug IDs but handle gracefully)
  if (teamEndIdx < 3) return null;

  // For now, assume team IDs are single parts (validated by reference Rust code)
  const teamIdA = parts[1];
  const teamIdB = parts[2];

  // Look up canonical names
  const teamNameA = TEAM_ID_TO_NAME[teamIdA] || normalizeTeamName(teamIdA);
  const teamNameB = TEAM_ID_TO_NAME[teamIdB] || normalizeTeamName(teamIdB);

  return { teams: [teamNameA, teamNameB], date };
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
  let yesTeam: string | undefined; // Which team outcome 0 (YES) represents

  // ── Platform-specific extraction ──────────────────────────────────────

  if (market.platform === 'kalshi') {
    const raw = market.raw as Record<string, unknown>;
    const ticker = (raw?.ticker as string) || market.id;

    // Try ticker-based extraction first (most reliable for Kalshi)
    teams = extractTeamsFromKalshiTicker(ticker);
    gameDate = extractDateFromKalshiTicker(ticker);

    // Kalshi per-team markets: the last segment of the ticker is the YES team.
    // e.g., KXNBAGAME-26MAR16PHXBOS-PHX → YES = PHX (suns)
    // Also check yes_sub_title from raw data as a fallback.
    const tickerParts = ticker.split('-');
    if (tickerParts.length >= 3) {
      const lastAbbrev = tickerParts[tickerParts.length - 1].toUpperCase();
      const yesTeamFromTicker = KALSHI_TEAM_ABBREVS[lastAbbrev];
      if (yesTeamFromTicker) {
        yesTeam = yesTeamFromTicker;
      }
    }
    // Fallback: use yes_sub_title from raw data (e.g., "Phoenix")
    if (!yesTeam) {
      const yesSubTitle = raw?.yes_sub_title as string | undefined;
      if (yesSubTitle) {
        yesTeam = normalizeTeamName(yesSubTitle);
      }
    }
  }

  if (market.platform === 'polymarket') {
    // Try slug-based extraction first (most reliable for Polymarket)
    // Slugs like "nba-cle-det-2025-10-27" give us team IDs + date directly
    const slugResult = extractFromPolymarketSlug(market.slug);
    if (slugResult) {
      teams = slugResult.teams;
      if (slugResult.date) gameDate = slugResult.date;
    }

    // Polymarket binary: outcomes[0] is the YES team.
    // e.g., outcomes: ["Suns", "Celtics"] → YES = Suns
    if (market.outcomes && market.outcomes.length >= 2) {
      const outcomeName = market.outcomes[0];
      // Only set yesTeam if the outcome name looks like a team (not "Yes"/"No")
      if (outcomeName && !/^(yes|no)$/i.test(outcomeName)) {
        yesTeam = normalizeTeamName(outcomeName);
      }
    }
  }

  if (market.platform === 'predictfun') {
    // predict.fun: outcomes[0] is the YES team
    if (market.outcomes && market.outcomes.length >= 2) {
      const outcomeName = market.outcomes[0];
      if (outcomeName && !/^(yes|no)$/i.test(outcomeName)) {
        yesTeam = normalizeTeamName(outcomeName);
      }
    }
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

  const league = detectLeague(market.question, market.category, market.slug, market.id);
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
    yesTeam,
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

    // ── Detect outcome inversion ──────────────────────────────────────────
    // If both markets have yesTeam set, check if YES on A means the same team as YES on B.
    // Example: Polymarket "Suns vs Celtics" (YES=suns) matched with Kalshi "PHX" market (YES=suns) → aligned
    // Example: Polymarket "Suns vs Celtics" (YES=suns) matched with Kalshi "BOS" market (YES=celtics) → inverted!
    let outcomesInverted = false;
    if (infoA.yesTeam && infoB.yesTeam) {
      outcomesInverted = infoA.yesTeam !== infoB.yesTeam;
      if (outcomesInverted) {
        log.info('Detected inverted outcomes between platforms', {
          marketA: { id: marketA.id, platform: marketA.platform, yesTeam: infoA.yesTeam },
          marketB: { id: marketB.id, platform: marketB.platform, yesTeam: infoB.yesTeam },
        });
      }
    }

    return {
      pairId,
      marketA,
      marketB,
      confidence,
      matchMethod: 'sports_normalized',
      outcomesInverted,
      status: this.pairStatuses.get(pairId) || 'approved', // Sports matches are auto-approved
    };
  }
}
