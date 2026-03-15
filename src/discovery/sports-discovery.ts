// ═══════════════════════════════════════════════════════════════════════════
// PRED-ARB :: Sports Discovery
// Orchestrates sports-specific market discovery across all platforms.
// Uses each platform's optimized sports API for targeted, high-quality results.
//
// Flow:
// 1. Call fetchSportsMarkets() on each connected connector (parallel)
// 2. Each connector uses its platform-specific sports query params
// 3. Results are enriched with parsed SportsMarketInfo (teams, date, league)
// 4. Returns a Map<Platform, DiscoveredMarket[]> ready for SportsMatcher
// ═══════════════════════════════════════════════════════════════════════════

import { Platform } from '../types';
import { MarketConnector } from '../types/connector';
import { createChildLogger } from '../utils/logger';
import {
  DiscoveredMarket,
  DiscoveryResult,
  SportsFetchOptions,
  SportsLeague,
} from './types';
import { parseSportsMarket } from '../matcher/sports-matcher';

const log = createChildLogger('sports-discovery');

/**
 * SportsDiscovery — orchestrates fetching sports markets from all platforms.
 *
 * Key differences from generic fetchMarkets():
 * - Uses platform-specific sports APIs (series_ticker for Kalshi, sports_market_types for PM)
 * - Time-bounded: only fetches events within lookAheadDays (default 3)
 * - Moneyline only (for arbitrage — spread/total are harder to match cross-platform)
 * - Enriches each market with parsed SportsMarketInfo
 *
 * Usage:
 *   const discovery = new SportsDiscovery();
 *   const result = await discovery.discover(connectors, { league: 'NBA', lookAheadDays: 3 });
 *   // result.markets is Map<Platform, DiscoveredMarket[]>
 */
export class SportsDiscovery {
  /**
   * Discover sports markets across all connected platforms.
   * Uses each connector's fetchSportsMarkets() if available,
   * falls back to generic fetchMarkets(category=sports) otherwise.
   */
  async discover(
    connectors: Map<Platform, MarketConnector>,
    options?: SportsFetchOptions,
  ): Promise<DiscoveryResult> {
    const startMs = Date.now();
    const markets = new Map<Platform, DiscoveredMarket[]>();
    const stats = {
      totalMarkets: 0,
      byPlatform: {} as Record<string, number>,
      byLeague: {} as Record<string, number>,
      parsedSuccessfully: 0,
      parseFailures: 0,
    };

    // Discover from all platforms in parallel
    const promises: Array<Promise<void>> = [];

    for (const [platform, connector] of connectors) {
      if (!connector.isConnected) continue;

      const promise = this.discoverFromPlatform(platform, connector, options)
        .then(discovered => {
          markets.set(platform, discovered);
          stats.byPlatform[platform] = discovered.length;
          stats.totalMarkets += discovered.length;

          // Count by league
          for (const m of discovered) {
            if (m.sportsInfo) {
              stats.parsedSuccessfully++;
              const league = m.sportsInfo.league;
              stats.byLeague[league] = (stats.byLeague[league] || 0) + 1;
            } else {
              stats.parseFailures++;
            }
          }
        })
        .catch(err => {
          log.warn(`Sports discovery failed for ${platform}`, {
            error: (err as Error).message,
          });
          markets.set(platform, []);
          stats.byPlatform[platform] = 0;
        });

      promises.push(promise);
    }

    await Promise.all(promises);

    const durationMs = Date.now() - startMs;

    log.info('Sports discovery complete', {
      ...stats,
      durationMs,
      platforms: Array.from(markets.keys()),
    });

    return { markets, durationMs, stats };
  }

  /**
   * Discover sports markets from a single platform.
   * Uses the connector's fetchSportsMarkets() if available,
   * falls back to generic fetchMarkets with category filter.
   */
  private async discoverFromPlatform(
    platform: Platform,
    connector: MarketConnector,
    options?: SportsFetchOptions,
  ): Promise<DiscoveredMarket[]> {
    // Use sports-specific method if available
    if (connector.fetchSportsMarkets) {
      log.info(`Using sports-specific discovery for ${platform}`, {
        league: options?.league,
        lookAheadDays: options?.lookAheadDays ?? 3,
      });
      return connector.fetchSportsMarkets(options);
    }

    // Fallback: generic fetch with sports category
    log.info(`Falling back to generic category fetch for ${platform}`);
    const markets = await connector.fetchMarkets({
      category: 'sports',
      activeOnly: true,
      limit: options?.maxResults ?? 1000,
      sortBy: 'volume',
      sortDirection: 'desc',
    });

    // Enrich with sports info
    return markets.map(m => {
      const discovered: DiscoveredMarket = { ...m };
      discovered.sportsInfo = parseSportsMarket(discovered) || undefined;
      return discovered;
    });
  }
}
