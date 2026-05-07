import { wrapHandler } from '../utils/errorHandling.js';
import { TradeApiClient } from '../services/tradeClient.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import { StatMapper } from '../services/statMapper.js';
import { ItemRecommendationEngine, UpgradeContext } from '../services/itemRecommendationEngine.js';
import { ItemListing, SearchOptions, ItemRecommendation, ResistanceRequirements, BudgetConstraints, TradeQuery } from '../types/tradeTypes.js';
import { CostBenefitAnalyzer } from '../services/costBenefitAnalyzer.js';
import { PoeNinjaClient } from '../services/poeNinjaClient.js';
import type { PoBLuaApiClient } from '../pobLuaBridge.js';

interface TradeContext {
  tradeClient: TradeApiClient;
  statMapper?: StatMapper;
  recommendationEngine?: ItemRecommendationEngine;
  ninjaClient?: PoeNinjaClient;
}

interface WeightedTradeContext extends TradeContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type WeightedTradeStatsGroup = Record<string, unknown> & {
  type?: unknown;
  filters?: unknown[];
};

type WeightedTradeQuery = Record<string, unknown> & {
  sort?: Record<string, unknown>;
  query?: Record<string, unknown> & {
    stats?: WeightedTradeStatsGroup[];
  };
};

const WEIGHTED_TRADE_SUPPORTED_SLOT_EXAMPLES = '"Belt", "Helmet", "Ring 1", or an exact PoB jewel slot name';
// Bounded live retries: keep the existing top-20 behavior first, then reduce
// on the same axis as PoB GUI's min-value halving fallback when GGG still
// rejects the weighted query. If this still fails live, min-value halving is
// the next adaptive strategy.
const WEIGHTED_TRADE_QUERY_TOO_COMPLEX_FALLBACK_CAPS = [20, 15, 10, 5] as const;

function normalizeWeightedTradeSlot(slot: string): string {
  const trimmed = slot.trim();
  const normalized = trimmed
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ');

  if (normalized === "watcher's eye" || normalized === 'watchers eye') {
    throw new Error(
      `slot resolution failed: "${trimmed}" is a unique item name, not an equipped PoB slot. ` +
      `find_weighted_trade_items supports equipped slots only (${WEIGHTED_TRADE_SUPPORTED_SLOT_EXAMPLES}). ` +
      'Use search_trade_items with explicit Watcher\'s Eye stat filters, or pass the exact equipped jewel slot name.'
    );
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSpecialItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[â€™`]/g, "'")
    .replace(/\s+/g, ' ');
}

function ensureRecordField(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function withUniqueItemConstraint(
  query: WeightedTradeQuery,
  name: string,
  type: string,
): WeightedTradeQuery {
  const constrained = cloneWeightedTradeQuery(query);
  if (!isRecord(constrained.query)) {
    constrained.query = {};
  }

  constrained.query.name = name;
  constrained.query.type = type;

  const filters = ensureRecordField(constrained.query, 'filters');
  const typeFilters = ensureRecordField(filters, 'type_filters');
  const typeFilterBody = ensureRecordField(typeFilters, 'filters');
  typeFilterBody.rarity = { option: 'unique' };

  return constrained;
}

const UNSUPPORTED_SPECIAL_NORMALIZERS: Record<string, {
  normalizeQuery: (query: WeightedTradeQuery) => WeightedTradeQuery;
  warning: string;
}> = {
  "watcher's eye": {
    normalizeQuery: (query) => withUniqueItemConstraint(query, "Watcher's Eye", 'Prismatic Jewel'),
    warning:
      'PoB does not support Watcher\'s Eye as a weighted-query special item; ' +
      'generated a normal jewel-slot weighted query and constrained the final trade query to unique Watcher\'s Eye.',
  },
};

function prepareWeightedTradeOptions(options?: Record<string, unknown>): {
  options?: Record<string, unknown>;
  normalizeQuery?: (query: WeightedTradeQuery) => WeightedTradeQuery;
  warning?: string;
} {
  const special = isRecord(options?.special) ? options?.special : undefined;
  const itemName = special?.itemName;
  if (typeof itemName !== 'string') {
    return { options };
  }

  const unsupported = UNSUPPORTED_SPECIAL_NORMALIZERS[normalizeSpecialItemName(itemName)];
  if (!unsupported) {
    return { options };
  }

  const normalizedOptions: Record<string, unknown> = { ...(options ?? {}) };
  const normalizedSpecial: Record<string, unknown> = { ...special };
  delete normalizedSpecial.itemName;
  if (Object.keys(normalizedSpecial).length > 0) {
    normalizedOptions.special = normalizedSpecial;
  } else {
    delete normalizedOptions.special;
  }

  return {
    options: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : undefined,
    normalizeQuery: unsupported.normalizeQuery,
    warning: unsupported.warning,
  };
}

function prepareWeightedTradeQueryForApi(query: WeightedTradeQuery): {
  query: WeightedTradeQuery;
  warnings: string[];
} {
  const warnings: string[] = [];
  const sort = isRecord(query.sort) ? query.sort : undefined;
  const unsupportedSortKeys = sort
    ? Object.keys(sort).filter((key) => key.startsWith('statgroup.'))
    : [];

  if (unsupportedSortKeys.length === 0) {
    return { query, warnings };
  }

  warnings.push(
    `PoB generated weighted sort key(s) ${unsupportedSortKeys.join(', ')}, ` +
    'which the public trade JSON API rejects. Falling back to price ascending; ' +
    'results are weighted-filter candidates, not final PoB-ranked DPS/eHP order.'
  );

  return {
    query: {
      ...query,
      sort: { price: 'asc' },
    },
    warnings,
  };
}

function isWeightedStatsGroup(group: unknown): group is WeightedTradeStatsGroup & { filters: unknown[] } {
  return isRecord(group) && group.type === 'weight' && Array.isArray(group.filters);
}

function getWeightedFilterCounts(query: WeightedTradeQuery): {
  statsKnown: boolean;
  weightedGroupCount: number;
  totalWeightedFilters: number;
  firstWeightedGroupFilters: number | null;
} {
  const stats = query.query?.stats;
  if (!Array.isArray(stats)) {
    return {
      statsKnown: false,
      weightedGroupCount: 0,
      totalWeightedFilters: 0,
      firstWeightedGroupFilters: null,
    };
  }

  let weightedGroupCount = 0;
  let totalWeightedFilters = 0;
  let firstWeightedGroupFilters: number | null = null;
  for (const group of stats) {
    if (!isWeightedStatsGroup(group)) continue;
    weightedGroupCount += 1;
    totalWeightedFilters += group.filters.length;
    if (firstWeightedGroupFilters === null) {
      firstWeightedGroupFilters = group.filters.length;
    }
  }

  return {
    statsKnown: true,
    weightedGroupCount,
    totalWeightedFilters,
    firstWeightedGroupFilters,
  };
}

function getWeightedModCount(query: WeightedTradeQuery): number | string {
  const counts = getWeightedFilterCounts(query);
  return counts.statsKnown ? counts.totalWeightedFilters : '?';
}

function hasWeightedStatsGroup(query: WeightedTradeQuery): boolean {
  return getWeightedFilterCounts(query).weightedGroupCount > 0;
}

function formatWeightedFilterSummary(query: WeightedTradeQuery): string {
  const counts = getWeightedFilterCounts(query);
  if (!counts.statsKnown) return 'unknown';
  const firstGroup =
    counts.firstWeightedGroupFilters === null
      ? 'none'
      : String(counts.firstWeightedGroupFilters);
  return `${counts.totalWeightedFilters} total, first weighted group: ${firstGroup}`;
}

function readRecordField(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(parent)) return undefined;
  const child = parent[key];
  return isRecord(child) ? child : undefined;
}

function readQueryShapeValue(parent: unknown, key: string): string | undefined {
  if (!isRecord(parent)) return undefined;
  const value = parent[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (isRecord(value)) {
    const option = value.option;
    if (typeof option === 'string' && option.length > 0) return option;
  }
  return undefined;
}

function describeWeightedTradeQueryShape(query: WeightedTradeQuery): string {
  const queryBody = query.query;
  const typeFilters = readRecordField(readRecordField(queryBody, 'filters'), 'type_filters');
  const typeFilterBody = readRecordField(typeFilters, 'filters');
  const category =
    readQueryShapeValue(typeFilterBody, 'category') ??
    readQueryShapeValue(queryBody, 'category') ??
    readQueryShapeValue(query, 'category') ??
    'unknown';
  const type =
    readQueryShapeValue(queryBody, 'type') ??
    readQueryShapeValue(query, 'type') ??
    'unknown';
  const name =
    readQueryShapeValue(queryBody, 'name') ??
    readQueryShapeValue(query, 'name') ??
    'unknown';

  return `category=${category}, type=${type}, name=${name}`;
}

function formatWeightedTradeQueryDiagnostics(query: WeightedTradeQuery): string {
  return `weighted filters: ${formatWeightedFilterSummary(query)}; query shape: ${describeWeightedTradeQueryShape(query)}`;
}

function getAbsNumericWeight(filter: unknown): number | null {
  if (!isRecord(filter)) return null;
  const value = filter.value;
  if (!isRecord(value)) return null;
  const weight = value.weight;
  return typeof weight === 'number' && Number.isFinite(weight) ? Math.abs(weight) : null;
}

function cloneWeightedTradeQuery(query: WeightedTradeQuery): WeightedTradeQuery {
  return JSON.parse(JSON.stringify(query)) as WeightedTradeQuery;
}

function buildTopWeightedFilterQuery(
  query: WeightedTradeQuery,
  maxFilters: number,
): {
  query: WeightedTradeQuery;
  originalWeightedFilterCount: number;
  reducedWeightedFilterCount: number;
  reduced: boolean;
} {
  const stats = query.query?.stats;
  if (!Array.isArray(stats)) {
    return {
      query,
      originalWeightedFilterCount: 0,
      reducedWeightedFilterCount: 0,
      reduced: false,
    };
  }

  const weightedGroupIndex = stats.findIndex(isWeightedStatsGroup);
  if (weightedGroupIndex < 0) {
    return {
      query,
      originalWeightedFilterCount: 0,
      reducedWeightedFilterCount: 0,
      reduced: false,
    };
  }

  const weightedGroup = stats[weightedGroupIndex];
  if (!isWeightedStatsGroup(weightedGroup)) {
    return {
      query,
      originalWeightedFilterCount: 0,
      reducedWeightedFilterCount: 0,
      reduced: false,
    };
  }
  const originalWeightedFilterCount = weightedGroup.filters.length;
  if (originalWeightedFilterCount <= maxFilters) {
    return {
      query,
      originalWeightedFilterCount,
      reducedWeightedFilterCount: originalWeightedFilterCount,
      reduced: false,
    };
  }

  const reducedQuery = cloneWeightedTradeQuery(query);
  const reducedStats = reducedQuery.query?.stats;
  if (!Array.isArray(reducedStats) || !isWeightedStatsGroup(reducedStats[weightedGroupIndex])) {
    return {
      query,
      originalWeightedFilterCount,
      reducedWeightedFilterCount: originalWeightedFilterCount,
      reduced: false,
    };
  }

  const rankedFilters = reducedStats[weightedGroupIndex].filters
    .map((filter, index) => ({
      filter,
      index,
      absWeight: getAbsNumericWeight(filter),
    }))
    .sort((a, b) => {
      if (a.absWeight !== null && b.absWeight !== null) {
        const byWeight = b.absWeight - a.absWeight;
        return byWeight !== 0 ? byWeight : a.index - b.index;
      }
      if (a.absWeight !== null) return -1;
      if (b.absWeight !== null) return 1;
      return a.index - b.index;
    })
    .slice(0, maxFilters)
    .sort((a, b) => a.index - b.index);

  reducedStats[weightedGroupIndex].filters = rankedFilters.map((entry) => entry.filter);

  return {
    query: reducedQuery,
    originalWeightedFilterCount,
    reducedWeightedFilterCount: rankedFilters.length,
    reduced: true,
  };
}

type WeightedFallbackAttempt = {
  cap: number;
  originalWeightedFilterCount: number;
  reducedWeightedFilterCount: number;
  query: WeightedTradeQuery;
  error: string;
};

function formatFallbackAttempt(attempt: WeightedFallbackAttempt): string {
  return `cap ${attempt.cap}: kept ${attempt.reducedWeightedFilterCount} of ` +
    `${attempt.originalWeightedFilterCount} weighted filters; ${attempt.error}`;
}

function isQueryTooComplexError(message: string): boolean {
  return /query is too complex/i.test(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ========================================
// Trade Site URL Helpers
// ========================================

function getTradeSearchUrl(league: string, searchId: string): string {
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchId}`;
}

function getTradeItemUrl(league: string, searchId: string, itemId: string): string {
  // Individual items can be highlighted in the search results
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchId}#${itemId}`;
}

/**
 * Search the Path of Exile trade site for items
 */
export async function handleSearchTradeItems(
  context: TradeContext,
  args: {
    league: string;
    item_name?: string;
    item_type?: string;
    min_price?: number;
    max_price?: number;
    price_currency?: string;
    online_only?: boolean;
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    min_links?: number;
    stats?: Array<{ id: string; min?: number; max?: number }>;
    sort?: 'price_asc' | 'price_desc';
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search trade items', async () => {
    const {
      league,
      item_name,
      item_type,
      min_price,
      max_price,
      price_currency = 'chaos',
      online_only = true,
      rarity,
      min_links,
      stats,
      sort = 'price_asc',
      limit = 5,
    } = args;

    // Build the query
    const builder = new TradeQueryBuilder();

    if (item_name) {
      builder.withName(item_name);
    }

    if (item_type) {
      builder.withType(item_type);
    }

    if (rarity) {
      builder.withRarity(rarity);
    }

    if (min_links) {
      builder.withLinks(min_links);
    }

    if (stats && stats.length > 0) {
      builder.withStats(stats);
    }

    builder.applyOptions({
      league,
      onlineOnly: online_only,
      minPrice: min_price,
      maxPrice: max_price,
      priceCurrency: price_currency,
      sort,
      limit,
    });

    const query = builder.build();

    // Execute search
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No items found matching your search criteria in ${league} league.`,
          },
        ],
      };
    }

    // Fetch first batch of items (up to limit)
    const itemIdsToFetch = searchResult.result.slice(0, Math.min(limit, 10));
    const items = await context.tradeClient.fetchItems(itemIdsToFetch, searchResult.id);

    // Format results with real-time currency rates
    const output = await formatSearchResults(items, searchResult.total, league, searchResult.id, context.ninjaClient);

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

/**
 * Get current market price for an item
 */
export async function handleGetItemPrice(
  context: TradeContext,
  args: {
    item_name: string;
    league?: string;
    item_type?: string;
    rarity?: 'unique' | 'rare' | 'magic' | 'normal';
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get item price', async () => {
    const { item_name, league = 'Standard', item_type, rarity } = args;

    // Build query
    const builder = new TradeQueryBuilder()
      .withName(item_name)
      .withOnlineStatus('available');

    if (item_type) {
      builder.withType(item_type);
    }

    if (rarity) {
      builder.withRarity(rarity);
    }

    builder.withSort('price', 'asc');

    const query = builder.build();

    // Search
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No price data found for "${item_name}" in ${league}.`,
          },
        ],
      };
    }

    // Fetch first 10 items to get price range
    const itemIdsToFetch = searchResult.result.slice(0, Math.min(10, searchResult.result.length));
    const items = await context.tradeClient.fetchItems(itemIdsToFetch, searchResult.id);

    // Calculate price statistics
    const prices = items
      .map(item => item.listing.price)
      .filter(price => price !== undefined)
      .map(price => ({
        amount: price!.amount,
        currency: price!.currency,
      }));

    if (prices.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No priced listings found for "${item_name}" in ${league}.`,
          },
        ],
      };
    }

    // Group by currency
    const byCurrency = new Map<string, number[]>();
    for (const price of prices) {
      if (!byCurrency.has(price.currency)) {
        byCurrency.set(price.currency, []);
      }
      byCurrency.get(price.currency)!.push(price.amount);
    }

    // Format output
    let output = `=== Price Check: ${item_name} ===\n`;
    output += `League: ${league}\n`;
    output += `Total Listings: ${searchResult.total}\n\n`;

    for (const [currency, amounts] of byCurrency.entries()) {
      amounts.sort((a, b) => a - b);
      const min = amounts[0];
      const max = amounts[amounts.length - 1];
      const median = amounts[Math.floor(amounts.length / 2)];
      const avg = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;

      output += `${currency}:\n`;
      output += `  Low: ${min.toFixed(1)} ${currency}\n`;
      output += `  Median: ${median.toFixed(1)} ${currency}\n`;
      output += `  Average: ${avg.toFixed(1)} ${currency}\n`;
      output += `  High: ${max.toFixed(1)} ${currency}\n`;
      output += `  Sample Size: ${amounts.length} listings\n\n`;
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

/**
 * Get available leagues
 */
export async function handleGetLeagues(
  context: TradeContext
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get leagues', async () => {
    const leagueData = await context.tradeClient.getLeagues();

    if (!leagueData.result || leagueData.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No leagues found.',
          },
        ],
      };
    }

    let output = '=== Available Leagues ===\n\n';

    for (const league of leagueData.result) {
      output += `- ${league.id}`;
      if (league.text) {
        output += ` (${league.text})`;
      }
      if (league.realm) {
        output += ` [${league.realm}]`;
      }
      output += '\n';
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// ========================================
// Helper Functions
// ========================================

/**
 * Fetch and map currency rates from poe.ninja
 * Maps full currency names to short names used by trade API
 */
async function getCurrencyRatesMap(ninjaClient: PoeNinjaClient | undefined, league: string): Promise<Map<string, number>> {
  if (!ninjaClient) {
    return new Map();
  }

  try {
    const rates = await ninjaClient.getCurrencyExchangeMap(league);

    // Map poe.ninja names to trade API currency names
    const mappedRates = new Map<string, number>();

    // Common currency mappings
    const nameMap: Record<string, string[]> = {
      'Divine Orb': ['divine', 'div'],
      'Chaos Orb': ['chaos', 'c'],
      'Exalted Orb': ['exalted', 'exa', 'ex'],
      'Mirror of Kalandra': ['mirror'],
      'Orb of Alchemy': ['alchemy', 'alch'],
      'Orb of Fusing': ['fusing', 'fuse'],
      'Orb of Regret': ['regret'],
      'Gemcutter\'s Prism': ['gcp'],
      'Chromatic Orb': ['chrome', 'chromatic'],
      'Jeweller\'s Orb': ['jewellers', 'jew'],
      'Orb of Alteration': ['alt', 'alteration'],
      'Vaal Orb': ['vaal'],
      'Cartographer\'s Chisel': ['chisel'],
      'Blessed Orb': ['blessed'],
      'Orb of Scouring': ['scouring', 'scour'],
    };

    // Add mappings
    for (const [fullName, chaosValue] of rates.entries()) {
      // Add the full name
      mappedRates.set(fullName, chaosValue);

      // Add short name mappings
      for (const [key, aliases] of Object.entries(nameMap)) {
        if (fullName === key) {
          for (const alias of aliases) {
            mappedRates.set(alias, chaosValue);
          }
        }
      }
    }

    return mappedRates;
  } catch (error) {
    console.error('[Trade] Failed to fetch currency rates from poe.ninja:', error);
    return new Map();
  }
}

async function formatSearchResults(items: ItemListing[], totalResults: number, league: string, searchId: string, ninjaClient?: PoeNinjaClient): Promise<string> {
  let output = `=== Trade Search (${league}) ===\n`;
  output += `Found: ${totalResults} | Showing: ${items.length}\n`;
  output += `🔗 ${getTradeSearchUrl(league, searchId)}\n\n`;

  // Fetch real-time currency rates from poe.ninja
  const currencyRates = await getCurrencyRatesMap(ninjaClient, league);

  // Analyze items for cost/benefit with real rates
  const analyzer = new CostBenefitAnalyzer();
  const analyses = analyzer.analyzeAndRank(items, currencyRates);

  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    const listing = analysis.listing;
    const item = listing.item;
    const price = listing.listing.price;
    const seller = listing.listing.account;
    const metrics = analysis.metrics;

    // Rank by value, not by search order
    const valueRank = analysis.rank || (i + 1);
    const searchRank = items.indexOf(listing) + 1;

    output += `${searchRank}. ${item.name || item.typeLine}`;

    // Show value indicator
    const tierEmoji = {
      'excellent': ' 💎',
      'good': ' ✨',
      'average': '',
      'poor': ' ⚠️'
    }[metrics.valueTier];
    output += tierEmoji;

    if (metrics.isBudgetPick) {
      output += ' 💰';
    }

    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}`;
      if (analysis.priceInChaos > 0 && price.currency !== 'chaos') {
        output += ` (~${analysis.priceInChaos.toFixed(0)} chaos)`;
      }
      output += `\n`;
    } else {
      output += `   Price: Not listed\n`;
    }

    // Show value score
    output += `   Value: ${metrics.valueScore.toFixed(0)}/100 (${metrics.valueTier})`;
    if (valueRank <= 3) {
      output += ` - #${valueRank} best value`;
    }
    output += `\n`;

    output += `   ilvl: ${item.ilvl}`;

    if (item.corrupted) {
      output += ' (Corrupted)';
    }

    output += '\n';

    // Links
    if (item.sockets && item.sockets.length > 0) {
      const maxLinks = getMaxLinks(item.sockets);
      if (maxLinks > 1) {
        output += `   Links: ${maxLinks}L\n`;
      }
    }

    // Show key stats in condensed format
    const stats = analysis.stats;
    const statParts: string[] = [];
    if (stats.life > 0) statParts.push(`+${stats.life} Life`);
    if (stats.es > 0) statParts.push(`+${stats.es} ES`);
    if (stats.totalResist > 0) statParts.push(`+${stats.totalResist}% Res`);
    if (statParts.length > 0) {
      output += `   Stats: ${statParts.join(', ')}\n`;
    }

    output += `   ${seller.online ? '🟢' : '🔴'} ${seller.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, searchId, listing.id)}\n\n`;
  }

  output += `\n💎=excellent ✨=good ⚠️=poor 💰=budget 🟢=online 🔴=offline`;
  return output;
}

function getMaxLinks(sockets: Array<{ group: number }>): number {
  const groups = new Map<number, number>();
  for (const socket of sockets) {
    const count = groups.get(socket.group) || 0;
    groups.set(socket.group, count + 1);
  }
  return Math.max(...groups.values());
}

/**
 * Search for stat IDs by name (fuzzy matching)
 */
export async function handleSearchStats(
  context: TradeContext,
  args: {
    query: string;
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search stats', async () => {
    const { query, limit = 10 } = args;

    if (!context.statMapper) {
      return {
        content: [
          {
            type: 'text',
            text: 'Stat mapper not available.',
          },
        ],
      };
    }

    const results = context.statMapper.fuzzySearch(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No stats found matching "${query}".`,
          },
        ],
      };
    }

    let output = `=== Stat Search Results for "${query}" ===\n\n`;
    output += `Found ${results.length} matching stats:\n\n`;

    for (let i = 0; i < results.length; i++) {
      const stat = results[i];
      output += `${i + 1}. ${stat.pobName}\n`;
      output += `   Trade ID: ${stat.tradeId}\n`;
      output += `   Category: ${stat.category}\n`;

      if (stat.description) {
        output += `   Description: ${stat.description}\n`;
      }

      if (stat.aliases.length > 0) {
        output += `   Aliases: ${stat.aliases.slice(0, 3).join(', ')}`;
        if (stat.aliases.length > 3) {
          output += ` (+${stat.aliases.length - 3} more)`;
        }
        output += '\n';
      }

      output += '\n';
    }

    output += `\nTo use in searches, reference the Trade ID in the stats parameter.`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// Phase 3: Recommendation Engine Handlers

export async function handleFindItemUpgrades(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find item upgrades', async () => {
    const {
      slot,
      league,
      build_needs,
      current_item,
      max_price = 100,
      currency = 'chaos',
      limit = 5,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const upgradeContext: UpgradeContext = {
      currentItem: current_item ? {
        name: current_item.name || 'Current Item',
        slot,
        life: current_item.life,
        es: current_item.es,
        resistances: {
          fire: current_item.fire_resist,
          cold: current_item.cold_resist,
          lightning: current_item.lightning_resist,
          chaos: current_item.chaos_resist,
        },
      } : undefined,
      buildNeeds: {
        lifeNeeded: build_needs?.life,
        esNeeded: build_needs?.es,
        dpsTarget: build_needs?.dps,
        resistanceGaps: (build_needs && (build_needs.fire_resist || build_needs.cold_resist || build_needs.lightning_resist)) ? {
          fire: build_needs.fire_resist || 0,
          cold: build_needs.cold_resist || 0,
          lightning: build_needs.lightning_resist || 0,
          chaos: build_needs.chaos_resist || 0,
        } : undefined,
      },
      budget: {
        maxPricePerItem: max_price,
        totalBudget: max_price * 2,
        currency,
      },
      league,
    };

    const recommendations = await context.recommendationEngine.findUpgrades(slot, upgradeContext);

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No upgrade recommendations found for ${slot} in ${league} within budget.` }],
      };
    }

    const output = formatItemRecommendations(recommendations.slice(0, limit), slot, league);
    return { content: [{ type: 'text', text: output }] };
  });
}

export async function handleFindResistanceGear(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find resistance gear', async () => {
    const {
      league,
      fire_resist_needed = 0,
      cold_resist_needed = 0,
      lightning_resist_needed = 0,
      chaos_resist_needed = 0,
      max_price_per_item = 50,
      total_budget = 200,
      currency = 'chaos',
      slots,
      limit = 8,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const resistanceGaps: ResistanceRequirements = {
      fire: fire_resist_needed,
      cold: cold_resist_needed,
      lightning: lightning_resist_needed,
      chaos: chaos_resist_needed,
    };

    const budget: BudgetConstraints = {
      maxPricePerItem: max_price_per_item,
      totalBudget: total_budget,
      currency,
    };

    const recommendations = await context.recommendationEngine.findResistanceGear(
      resistanceGaps,
      budget,
      league,
      slots
    );

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No resistance gear found in ${league} that matches your requirements within budget.` }],
      };
    }

    const output = formatResistanceRecommendations(recommendations.slice(0, limit), resistanceGaps, league, true);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemRecommendations(
  recommendations: ItemRecommendation[],
  slot: string,
  league: string,
  includeLinks: boolean = false
): string {
  let output = `=== ${slot} Upgrades (${league}) ===\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit) {
      const cb = rec.costBenefit;
      if (cb.lifeGain && cb.lifeGain > 0) {
        output += `   Life Gain: +${cb.lifeGain}\n`;
      }
      if (cb.esGain && cb.esGain > 0) {
        output += `   ES Gain: +${cb.esGain}\n`;
      }
      if (cb.efficiency) {
        output += `   Efficiency: ${cb.efficiency.toFixed(2)} points per ${cb.currency}\n`;
      }
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 3)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

function formatResistanceRecommendations(
  recommendations: ItemRecommendation[],
  resistanceGaps: ResistanceRequirements,
  league: string,
  includeLinks: boolean = false
): string {
  const targets = [];
  if (resistanceGaps.fire > 0) targets.push(`${resistanceGaps.fire}% Fire`);
  if (resistanceGaps.cold > 0) targets.push(`${resistanceGaps.cold}% Cold`);
  if (resistanceGaps.lightning > 0) targets.push(`${resistanceGaps.lightning}% Lightning`);
  if (resistanceGaps.chaos && resistanceGaps.chaos > 0) targets.push(`${resistanceGaps.chaos}% Chaos`);

  let output = `=== Resistance Gear (${league}) ===\n`;
  output += `Need: ${targets.join(', ')}\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.typeLine && item.name !== item.typeLine) {
      output += `   Type: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit.resistGain) {
      const gains = [];
      const rg = rec.costBenefit.resistGain;
      if (rg.fire) gains.push(`${rg.fire}% Fire`);
      if (rg.cold) gains.push(`${rg.cold}% Cold`);
      if (rg.lightning) gains.push(`${rg.lightning}% Lightning`);
      if (rg.chaos) gains.push(`${rg.chaos}% Chaos`);

      if (gains.length > 0) {
        output += `   Provides: ${gains.join(', ')}\n`;
      }
    }

    if (rec.costBenefit.efficiency) {
      output += `   Efficiency: ${rec.costBenefit.efficiency.toFixed(2)} resist per ${rec.costBenefit.currency}\n`;
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 2)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

/**
 * Compare multiple trade items side-by-side
 */
export async function handleCompareTradeItems(
  context: TradeContext,
  args: {
    item_ids: string[];
    build_context?: {
      life_needed?: number;
      es_needed?: number;
      dps_target?: number;
      fire_resist_needed?: number;
      cold_resist_needed?: number;
      lightning_resist_needed?: number;
    };
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('compare trade items', async () => {
    const { item_ids, build_context } = args;

    if (!item_ids || item_ids.length === 0) {
      return {
        content: [{ type: 'text', text: 'No item IDs provided for comparison.' }],
      };
    }

    if (item_ids.length > 5) {
      return {
        content: [{ type: 'text', text: 'Can only compare up to 5 items at once.' }],
      };
    }

    const items = await context.tradeClient.fetchItems(item_ids);

    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No items found with the provided IDs.' }],
      };
    }

    const output = formatItemComparison(items, build_context);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemComparison(
  items: ItemListing[],
  buildContext?: {
    life_needed?: number;
    es_needed?: number;
    dps_target?: number;
    fire_resist_needed?: number;
    cold_resist_needed?: number;
    lightning_resist_needed?: number;
  }
): string {
  let output = `=== Item Comparison (${items.length}) ===\n\n`;

  const itemStats = items.map(listing => {
    const item = listing.item;
    const price = listing.listing.price;

    return {
      name: item.name || item.typeLine,
      typeLine: item.typeLine,
      price: price ? price.amount + ' ' + price.currency : 'No price',
      priceAmount: price?.amount || 0,
      ilvl: item.ilvl,
      corrupted: item.corrupted || false,
      links: item.sockets ? getMaxLinks(item.sockets) : 0,
      life: extractStatValue(item, 'life'),
      es: extractStatValue(item, 'energy shield'),
      armour: extractStatValue(item, 'armour'),
      evasion: extractStatValue(item, 'evasion'),
      fireResist: extractResistValue(item, 'fire'),
      coldResist: extractResistValue(item, 'cold'),
      lightningResist: extractResistValue(item, 'lightning'),
      chaosResist: extractResistValue(item, 'chaos'),
      seller: listing.listing.account.name,
      online: listing.listing.account.online,
    };
  });

  const maxLife = Math.max(...itemStats.map(i => i.life));
  const maxES = Math.max(...itemStats.map(i => i.es));
  const minPrice = Math.min(...itemStats.filter(i => i.priceAmount > 0).map(i => i.priceAmount));

  for (let i = 0; i < itemStats.length; i++) {
    const stats = itemStats[i];
    output += (i + 1) + '. ' + stats.name + '\n';

    if (stats.name !== stats.typeLine) {
      output += '   Base: ' + stats.typeLine + '\n';
    }

    output += '   Price: ' + stats.price;
    if (stats.priceAmount === minPrice && minPrice > 0) {
      output += ' 💰 (Best Value)';
    }
    output += '\n';

    output += '   ilvl: ' + stats.ilvl;
    if (stats.corrupted) output += ' (Corrupted)';
    output += '\n';

    if (stats.links > 0) {
      output += '   Links: ' + stats.links + 'L\n';
    }

    if (stats.life > 0) {
      output += '   Life: +' + stats.life;
      if (stats.life === maxLife) output += ' ⭐';
      if (buildContext?.life_needed && stats.life >= buildContext.life_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.es > 0) {
      output += '   ES: +' + stats.es;
      if (stats.es === maxES) output += ' ⭐';
      if (buildContext?.es_needed && stats.es >= buildContext.es_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.armour > 0) {
      output += '   Armour: ' + stats.armour + '\n';
    }

    if (stats.evasion > 0) {
      output += '   Evasion: ' + stats.evasion + '\n';
    }

    const resists = [];
    if (stats.fireResist > 0) {
      let resistStr = stats.fireResist + '% Fire';
      if (buildContext?.fire_resist_needed && stats.fireResist >= buildContext.fire_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.coldResist > 0) {
      let resistStr = stats.coldResist + '% Cold';
      if (buildContext?.cold_resist_needed && stats.coldResist >= buildContext.cold_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.lightningResist > 0) {
      let resistStr = stats.lightningResist + '% Lightning';
      if (buildContext?.lightning_resist_needed && stats.lightningResist >= buildContext.lightning_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.chaosResist > 0) {
      resists.push(stats.chaosResist + '% Chaos');
    }

    if (resists.length > 0) {
      output += '   Resistances: ' + resists.join(', ') + '\n';
    }

    output += '   Seller: ' + stats.seller;
    if (stats.online) output += ' (Online)';
    output += '\n\n';
  }

  output += '=== Summary ===\n';
  output += '⭐ = Best value for that stat\n';
  output += '✓ = Meets build requirement\n';
  output += '💰 = Cheapest option\n';

  return output;
}

function extractStatValue(item: any, statName: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  for (const mod of allMods) {
    if (mod.toLowerCase().includes(statName.toLowerCase())) {
      const match = mod.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  return 0;
}

function extractResistValue(item: any, element: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  let total = 0;

  for (const mod of allMods) {
    const lowerMod = mod.toLowerCase();

    if (lowerMod.includes(element + ' resistance')) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }

    if ((element === 'fire' || element === 'cold' || element === 'lightning') &&
        (lowerMod.includes('all elemental resistances') || lowerMod.includes('to all resistances'))) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }
  }

  return total;
}

/**
 * Find best-in-slot trade items for the loaded PoB build using PoB's
 * TradeQueryGenerator weighted-search engine. Generates a query JSON keyed by
 * real DPS/eHP impact for the build, then executes it against the PoE trade API.
 */
type WeightedTradeSortMode = 'StatValue' | 'StatValuePrice' | 'Price' | 'Weight';

const WEIGHTED_TRADE_VALID_SORT_MODES: ReadonlySet<WeightedTradeSortMode> = new Set([
  'StatValue',
  'StatValuePrice',
  'Price',
  'Weight',
]);

const WEIGHTED_TRADE_FETCH_CAP = 10;

// Trade-API currency code → poe.ninja currencyTypeName. Trade uses short codes,
// poe.ninja uses canonical orb names. Limited to the most common league
// currencies; unknown codes fall through to omitting the chaos value (and
// price-aware sort modes degrade gracefully on the Lua side).
const TRADE_CURRENCY_TO_NINJA_NAME: Record<string, string> = {
  chaos: 'Chaos Orb',
  div: 'Divine Orb',
  divine: 'Divine Orb',
  exa: 'Exalted Orb',
  exalted: 'Exalted Orb',
  mirror: 'Mirror of Kalandra',
  alch: 'Orb of Alchemy',
  alt: 'Orb of Alteration',
  regal: 'Regal Orb',
  fuse: 'Orb of Fusing',
  vaal: 'Vaal Orb',
  blessed: 'Blessed Orb',
  scour: 'Orb of Scouring',
  chrome: 'Chromatic Orb',
  jew: "Jeweller's Orb",
  gcp: "Gemcutter's Prism",
  awakened: "Awakener's Orb",
};

function decodeItemTextBase64(b64: string | undefined): string | null {
  if (typeof b64 !== 'string' || b64 === '') return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function formatStatDelta(stat: string, delta: number): string {
  const sign = delta >= 0 ? '+' : '';
  if (Math.abs(delta) >= 1) {
    return `${stat} ${sign}${Math.round(delta).toLocaleString('en-US')}`;
  }
  return `${stat} ${sign}${delta.toFixed(3)}`;
}

/**
 * Resolve chaos-equivalent for a listing price using poe.ninja rates when
 * available. Returns null if we can't resolve confidently.
 */
function resolveChaosEquivalent(
  amount: number | undefined,
  currency: string | undefined,
  rates: Map<string, number> | null,
): number | null {
  if (typeof amount !== 'number' || amount <= 0) return null;
  if (!currency) return null;
  const lowered = currency.toLowerCase();
  if (lowered === 'chaos') return amount;
  if (!rates) return null;
  const ninjaName = TRADE_CURRENCY_TO_NINJA_NAME[lowered];
  if (!ninjaName) return null;
  const rate = rates.get(ninjaName);
  if (typeof rate !== 'number' || rate <= 0) return null;
  return amount * rate;
}

function isStatWeightArray(value: unknown): value is Array<{ stat: string; label?: string; weightMult: number }> {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.stat !== 'string' || e.stat === '') return false;
    if (typeof e.weightMult !== 'number') return false;
  }
  return true;
}

export async function handleFindWeightedTradeItems(
  context: WeightedTradeContext,
  args: {
    league: string;
    slot: string;
    options?: Record<string, unknown>;
    limit?: number;
    sortMode?: WeightedTradeSortMode;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find weighted trade items', async () => {
    const { league, slot, options, limit = 5 } = args;
    const sortMode: WeightedTradeSortMode = args.sortMode ?? 'StatValue';
    if (!league) throw new Error('league is required');
    if (!slot) throw new Error('slot is required (e.g. "Belt", "Ring 1", "Body Armour")');
    if (!WEIGHTED_TRADE_VALID_SORT_MODES.has(sortMode)) {
      throw new Error(
        `invalid sortMode: "${sortMode}" (allowed: StatValue, StatValuePrice, Price, Weight)`,
      );
    }
    const normalizedSlot = normalizeWeightedTradeSlot(slot);

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized — load a build first');

    const preparedOptions = prepareWeightedTradeOptions(options);
    const optionWarnings = preparedOptions.warning ? [preparedOptions.warning] : [];
    let pobQuery: unknown;
    let warning: string | undefined;
    try {
      const result = await luaClient.generateWeightedTradeQuery(normalizedSlot, preparedOptions.options);
      pobQuery = result.query;
      warning = result.warning;
    } catch (error) {
      const message = formatError(error);
      if (message.startsWith('unknown slot:')) {
        throw new Error(
          `slot resolution failed: ${message}. ` +
          `Pass an exact equipped PoB slot name (${WEIGHTED_TRADE_SUPPORTED_SLOT_EXAMPLES}).`
        );
      }
      throw error;
    }

    if (!pobQuery || typeof pobQuery !== 'object') {
      throw new Error(`PoB returned no query JSON${warning ? ` (${warning})` : ''}`);
    }

    if (preparedOptions.normalizeQuery) {
      pobQuery = preparedOptions.normalizeQuery(pobQuery as WeightedTradeQuery);
    }

    const { query: apiQuery, warnings: prepareWarnings } = prepareWeightedTradeQueryForApi(
      pobQuery as WeightedTradeQuery,
    );
    let effectiveQuery = apiQuery;
    const searchWarnings: string[] = [];
    let searchResult;
    try {
      searchResult = await context.tradeClient.searchItems(league, apiQuery as unknown as TradeQuery);
    } catch (error) {
      const originalErrorMessage = formatError(error);
      if (!isQueryTooComplexError(originalErrorMessage)) {
        throw new Error(`trade API query failed for slot "${normalizedSlot}": ${originalErrorMessage}`);
      }

      if (hasWeightedStatsGroup(apiQuery) && !process.env.POE_SESSION_ID) {
        throw new Error(
          `trade API query failed for slot "${normalizedSlot}": ${originalErrorMessage}. ` +
          'The query contains a type:"weight" stat group and POE_SESSION_ID is not configured; ' +
          'GGG rejects anonymous weighted-stat searches with "Query is too complex". ' +
          'Set POE_SESSION_ID before using find_weighted_trade_items. ' +
          `Diagnostics: ${formatWeightedTradeQueryDiagnostics(apiQuery)}.`
        );
      }

      const fallbackAttempts: WeightedFallbackAttempt[] = [];
      let fallbackSucceeded = false;
      for (const cap of WEIGHTED_TRADE_QUERY_TOO_COMPLEX_FALLBACK_CAPS) {
        const fallback = buildTopWeightedFilterQuery(apiQuery, cap);
        if (!fallback.reduced) continue;

        try {
          searchResult = await context.tradeClient.searchItems(
            league,
            fallback.query as unknown as TradeQuery,
          );
          effectiveQuery = fallback.query;
          fallbackSucceeded = true;
          const triedCaps = [...fallbackAttempts.map((attempt) => attempt.cap), cap];
          searchWarnings.push(
            `Original GGG /search rejected the weighted query as too complex; retried with top ` +
            `${fallback.reducedWeightedFilterCount} of ${fallback.originalWeightedFilterCount} ` +
            `weighted filters (winning cap ${cap}; attempted caps: [${triedCaps.join(', ')}]). ` +
            'Candidate pool is a narrowed subset of the original query intent; dropped filters were ' +
            'lower-weight or unweighted, and local PoB ranking still re-ranks fetched candidates.'
          );
          break;
        } catch (fallbackError) {
          fallbackAttempts.push({
            cap,
            originalWeightedFilterCount: fallback.originalWeightedFilterCount,
            reducedWeightedFilterCount: fallback.reducedWeightedFilterCount,
            query: fallback.query,
            error: formatError(fallbackError),
          });
        }
      }

      if (!fallbackSucceeded) {
        if (fallbackAttempts.length === 0) {
          throw new Error(
            `trade API query failed for slot "${normalizedSlot}": ${originalErrorMessage}. ` +
            `No smaller top-N weighted retry was available (${formatWeightedTradeQueryDiagnostics(apiQuery)}).`
          );
        }

        const lastAttempt = fallbackAttempts[fallbackAttempts.length - 1];
        throw new Error(
          `trade API query failed for slot "${normalizedSlot}": original /search failed: ` +
          `${originalErrorMessage}. All top-N weighted fallback caps failed. ` +
          `Attempted fallback caps: [${fallbackAttempts.map((attempt) => attempt.cap).join(', ')}]. ` +
          `Per-cap errors: ${fallbackAttempts.map(formatFallbackAttempt).join(' | ')}. ` +
          `Original diagnostics: ${formatWeightedTradeQueryDiagnostics(apiQuery)}. ` +
          `Final fallback diagnostics: ${formatWeightedTradeQueryDiagnostics(lastAttempt.query)}.`
        );
      }
    }

    if (!searchResult) {
      throw new Error(`trade API query failed for slot "${normalizedSlot}": no search result returned`);
    }

    const warningText = [warning, ...optionWarnings, ...searchWarnings].filter((line): line is string => !!line);

    if (!searchResult.result || searchResult.result.length === 0) {
      const empty =
        `=== Weighted BIS Search (${league}, slot: ${normalizedSlot}) ===\n` +
        `No items found.\n` +
        warningText.map((line) => `Warning: ${line}\n`).join('') +
        `Query had ${getWeightedModCount(effectiveQuery)} weighted mods.\n` +
        `Query shape: ${describeWeightedTradeQueryShape(effectiveQuery)} | ` +
        `Weighted filters: ${formatWeightedFilterSummary(effectiveQuery)}.\n`;
      return { content: [{ type: 'text', text: empty }] };
    }

    const itemIds = searchResult.result.slice(0, WEIGHTED_TRADE_FETCH_CAP);
    const fetchedItems = await context.tradeClient.fetchItems(itemIds, searchResult.id);

    // Look up currency exchange rates if needed for price-aware ranking. Skip
    // the network call when nothing is non-chaos-priced.
    const needsRates =
      (sortMode === 'Price' || sortMode === 'StatValuePrice') &&
      fetchedItems.some(
        (l) =>
          l.listing.price &&
          typeof l.listing.price.amount === 'number' &&
          (l.listing.price.currency || '').toLowerCase() !== 'chaos',
      );
    let exchangeRates: Map<string, number> | null = null;
    if (needsRates && context.ninjaClient) {
      try {
        exchangeRates = await context.ninjaClient.getCurrencyExchangeMap(league);
      } catch {
        exchangeRates = null;
      }
    }

    const rankInputs = fetchedItems.map((listing) => {
      const itemString = decodeItemTextBase64(listing.item.extended?.text);
      const priceAmount = listing.listing.price?.amount;
      const priceCurrency = listing.listing.price?.currency;
      const chaos = resolveChaosEquivalent(priceAmount, priceCurrency, exchangeRates);
      return {
        item_string: itemString ?? '',
        price:
          typeof priceAmount === 'number'
            ? {
                amount: priceAmount,
                currency: priceCurrency,
                chaos: chaos ?? undefined,
              }
            : undefined,
      };
    });

    const rankableInputs = rankInputs.filter((entry) => entry.item_string.length > 0);
    const skippedCount = rankInputs.length - rankableInputs.length;

    let rankedOrder: number[] = [];
    let resolvedSortMode: WeightedTradeSortMode = sortMode;
    let rankedDetails: Array<{
      index: number;
      weight: number;
      deltas: Record<string, number>;
      error?: string;
    }> = [];
    const rankWarnings: string[] = [];

    if (rankableInputs.length === 0) {
      rankWarnings.push(
        'PoB ranking skipped — no fetched items exposed extended.text (base64 item description).',
      );
    } else {
      // Forward user-supplied statWeights so the local ranking matches the
      // weights the user asked PoB to query against. Without this, rankTradeResults
      // silently uses the Lua-side default (FullDPS 1.0 + TotalEHP 0.5) and the
      // ranking can disagree with the search.
      const userStatWeights = options
        ? (options as Record<string, unknown>).statWeights
        : undefined;
      const validatedStatWeights = isStatWeightArray(userStatWeights) ? userStatWeights : undefined;
      try {
        const rankResult = await luaClient.rankTradeResults({
          slot: normalizedSlot,
          items: rankableInputs,
          sortMode,
          statWeights: validatedStatWeights,
        });
        rankedDetails = rankResult.ranked;
        if (rankResult.sortMode && rankResult.sortMode !== sortMode) {
          resolvedSortMode = rankResult.sortMode as WeightedTradeSortMode;
          rankWarnings.push(
            `Requested sort "${sortMode}" fell back to "${resolvedSortMode}" (likely missing prices).`,
          );
        }
        rankedOrder = rankResult.ranked.map((r) => r.index - 1); // Lua 1-based → 0-based on rankableInputs
      } catch (error) {
        rankWarnings.push(`PoB ranking failed: ${formatError(error)} — falling back to fetch order.`);
      }
    }

    const detailByOriginalIndex = new Map<number, { weight: number; deltas: Record<string, number>; error?: string }>();
    if (rankedOrder.length > 0) {
      // rankableInputs[k] corresponds to fetchedItems[fetchedIndexOfRankable[k]]
      const fetchedIndexOfRankable: number[] = [];
      rankInputs.forEach((entry, originalIdx) => {
        if (entry.item_string.length > 0) fetchedIndexOfRankable.push(originalIdx);
      });
      rankedDetails.forEach((detail) => {
        const rankableIdx = detail.index - 1;
        const fetchedIdx = fetchedIndexOfRankable[rankableIdx];
        if (typeof fetchedIdx === 'number') {
          detailByOriginalIndex.set(fetchedIdx, {
            weight: detail.weight,
            deltas: detail.deltas,
            error: detail.error,
          });
        }
      });
    }

    // Build the final ordered list: ranked items first (in rank order), then any
    // items we couldn't rank (preserves visibility of unrankable listings).
    const orderedFetchedIndices: number[] = [];
    if (rankedOrder.length > 0) {
      const fetchedIndexOfRankable: number[] = [];
      rankInputs.forEach((entry, originalIdx) => {
        if (entry.item_string.length > 0) fetchedIndexOfRankable.push(originalIdx);
      });
      rankedDetails.forEach((detail) => {
        const fetchedIdx = fetchedIndexOfRankable[detail.index - 1];
        if (typeof fetchedIdx === 'number') orderedFetchedIndices.push(fetchedIdx);
      });
      rankInputs.forEach((entry, originalIdx) => {
        if (entry.item_string.length === 0) orderedFetchedIndices.push(originalIdx);
      });
    } else {
      // No ranking happened → preserve fetch (= price-asc) order.
      fetchedItems.forEach((_, idx) => orderedFetchedIndices.push(idx));
    }

    const cap = Math.min(limit, orderedFetchedIndices.length);
    const orderedItems = orderedFetchedIndices.slice(0, cap).map((idx) => ({
      listing: fetchedItems[idx],
      detail: detailByOriginalIndex.get(idx),
    }));

    let output = `=== Weighted BIS Search (${league}, slot: ${normalizedSlot}) ===\n`;
    output += `Total matches: ${searchResult.total} | Ranked: ${rankedDetails.length}/${fetchedItems.length} | Showing: ${orderedItems.length}\n`;
    output += `Query shape: ${describeWeightedTradeQueryShape(effectiveQuery)} | Weighted filters: ${formatWeightedFilterSummary(effectiveQuery)}\n`;
    output += `🔗 ${getTradeSearchUrl(league, searchResult.id)}\n`;
    output += `Sort: ${resolvedSortMode}`;
    if (resolvedSortMode === 'StatValue' || resolvedSortMode === 'StatValuePrice') {
      output += ` (build-impact ranked locally via PoB)`;
    }
    output += `\n`;
    if (skippedCount > 0) {
      output += `Note: ${skippedCount} fetched listing(s) lacked extended.text and were left unranked.\n`;
    }
    for (const line of warningText) output += `Warning: ${line}\n`;
    for (const line of rankWarnings) output += `Warning: ${line}\n`;
    if (prepareWarnings.length > 0) {
      output += `Note: PoB-generated query had ${prepareWarnings.length} unsupported sort key(s) stripped before submission to GGG; ranking is computed locally so the server-side sort is not load-bearing.\n`;
    }
    output += `\n`;

    orderedItems.forEach(({ listing, detail }, i) => {
      const item = listing.item;
      const price = listing.listing.price;
      const seller = listing.listing.account?.name ?? 'unknown';
      output += `${i + 1}. ${item.name || item.typeLine}`;
      if (item.name && item.typeLine && item.name !== item.typeLine) {
        output += ` (${item.typeLine})`;
      }
      output += `\n`;
      if (price) output += `   Price: ${price.amount} ${price.currency}\n`;
      output += `   Seller: ${seller}\n`;
      if (detail && !detail.error) {
        const deltaParts: string[] = [];
        for (const [stat, value] of Object.entries(detail.deltas)) {
          if (typeof value === 'number' && Math.abs(value) > 1e-6) {
            deltaParts.push(formatStatDelta(stat, value));
          }
        }
        if (deltaParts.length > 0) {
          output += `   Impact: ${deltaParts.join(', ')}\n`;
        }
        if (typeof detail.weight === 'number') {
          output += `   Weighted score: ${detail.weight.toFixed(4)}\n`;
        }
      } else if (detail?.error) {
        output += `   Impact: (unrankable: ${detail.error})\n`;
      }
      const mods = [
        ...(item.explicitMods || []),
        ...(item.implicitMods || []),
        ...(item.craftedMods || []),
      ];
      if (mods.length > 0) {
        output += `   Mods:\n`;
        for (const m of mods.slice(0, 8)) output += `     - ${m}\n`;
        if (mods.length > 8) output += `     … (${mods.length - 8} more)\n`;
      }
      output += `\n`;
    });

    return { content: [{ type: 'text', text: output }] };
  });
}
