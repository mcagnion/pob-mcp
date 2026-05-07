import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { handleFindWeightedTradeItems } from '../../src/handlers/tradeHandlers.js';
import { formatPoeSessionIdDiagnostic } from '../../src/utils/poeSessionDiagnostics.js';

const originalPoeSessionId = process.env.POE_SESSION_ID;

afterEach(() => {
  if (originalPoeSessionId === undefined) {
    delete process.env.POE_SESSION_ID;
  } else {
    process.env.POE_SESSION_ID = originalPoeSessionId;
  }
});

function createContext(opts: {
  generateResult?: unknown;
  searchResult?: unknown;
  fetchedItems?: unknown[];
  rankResult?: unknown;
  rankRejection?: Error;
  ninjaRates?: Map<string, number>;
} = {}) {
  const luaClient: {
    generateWeightedTradeQuery: ReturnType<typeof jest.fn>;
    rankTradeResults: ReturnType<typeof jest.fn>;
  } = {
    generateWeightedTradeQuery: jest.fn().mockResolvedValue(
      (opts.generateResult ?? { query: {} }) as never,
    ),
    rankTradeResults: jest.fn(),
  };
  if (opts.rankRejection) {
    luaClient.rankTradeResults.mockRejectedValue(opts.rankRejection as never);
  } else {
    luaClient.rankTradeResults.mockResolvedValue(
      (opts.rankResult ?? { ranked: [], sortMode: 'StatValue' }) as never,
    );
  }

  const tradeClient = {
    searchItems: jest.fn().mockResolvedValue(
      (opts.searchResult ?? { id: 'abc123', total: 0, result: [] }) as never,
    ),
    fetchItems: jest.fn().mockResolvedValue((opts.fetchedItems ?? []) as never),
  };

  const ninjaClient = opts.ninjaRates
    ? {
        getCurrencyExchangeMap: jest.fn().mockResolvedValue(opts.ninjaRates as never),
      }
    : undefined;

  return {
    context: {
      tradeClient,
      ninjaClient,
      ensureLuaClient: jest.fn().mockResolvedValue(undefined as never),
      getLuaClient: jest.fn(() => luaClient),
    } as any,
    luaClient,
    tradeClient,
    ninjaClient,
  };
}

function buildItemTextBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function buildListing(opts: {
  id: string;
  name: string;
  typeLine: string;
  itemText: string;
  priceAmount?: number;
  priceCurrency?: string;
}) {
  return {
    id: opts.id,
    listing: {
      method: 'psapi',
      indexed: '2026-05-07T00:00:00Z',
      whisper: '@example',
      account: { name: 'Seller_' + opts.id },
      price:
        opts.priceAmount !== undefined
          ? {
              type: '~price',
              amount: opts.priceAmount,
              currency: opts.priceCurrency || 'chaos',
            }
          : undefined,
    },
    item: {
      verified: true,
      w: 1,
      h: 1,
      icon: '',
      league: 'Standard',
      id: 'item_' + opts.id,
      name: opts.name,
      typeLine: opts.typeLine,
      baseType: opts.typeLine,
      identified: true,
      ilvl: 84,
      frameType: 2,
      explicitMods: ['+85 to maximum Life', '+45% to Fire Resistance'],
      extended: {
        text: buildItemTextBase64(opts.itemText),
      },
    },
  };
}

function weightedFilter(id: string, weight?: number) {
  return weight === undefined ? { id } : { id, value: { weight } };
}

function buildWeightedQuery(filters: unknown[], category = 'accessory.belt') {
  return {
    query: {
      filters: {
        type_filters: {
          filters: {
            category: { option: category },
          },
        },
      },
      stats: [
        {
          type: 'weight',
          filters,
        },
      ],
    },
    sort: { 'statgroup.0': 'desc' },
    engine: 'new',
  };
}

describe('formatPoeSessionIdDiagnostic', () => {
  it('reports absent session without a fingerprint', () => {
    delete process.env.POE_SESSION_ID;
    expect(formatPoeSessionIdDiagnostic()).toBe('POE_SESSION_ID configured: no');
  });

  it('reports a redacted session fingerprint without leaking the full value', () => {
    const fullSessionId = 'abcd1234efgh5678ijkl9012mnop3456';
    const diagnostic = formatPoeSessionIdDiagnostic(fullSessionId);

    expect(diagnostic).toContain('POE_SESSION_ID configured: yes');
    expect(diagnostic).toContain('length=32');
    expect(diagnostic).toContain('fingerprint=abcd...3456');
    expect(diagnostic).not.toContain(fullSessionId);
  });
});

describe('handleFindWeightedTradeItems', () => {
  it("rejects Watcher's Eye as a slot name before calling PoB", async () => {
    const { context, luaClient, tradeClient } = createContext();

    await expect(
      handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: "Watcher's Eye",
      }),
    ).rejects.toThrow(/unique item name, not an equipped PoB slot/);

    expect(luaClient.generateWeightedTradeQuery).not.toHaveBeenCalled();
    expect(tradeClient.searchItems).not.toHaveBeenCalled();
  });

  it('rejects unknown sortMode before calling any backend', async () => {
    const { context, luaClient, tradeClient } = createContext();

    await expect(
      handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Belt',
        sortMode: 'CheapestThenWeight' as any,
      }),
    ).rejects.toThrow(/invalid sortMode/);

    expect(luaClient.generateWeightedTradeQuery).not.toHaveBeenCalled();
    expect(tradeClient.searchItems).not.toHaveBeenCalled();
  });

  it('strips PoB statgroup sort to a JSON-API-supported sort before calling /search', async () => {
    const pobQuery = {
      query: {
        filters: {
          type_filters: {
            filters: {
              category: { option: 'accessory.belt' },
            },
          },
        },
        stats: [
          {
            type: 'weight',
            filters: [{ id: 'explicit.stat_123', value: { weight: 1.5 } }],
          },
        ],
      },
      sort: { 'statgroup.0': 'desc' },
      engine: 'new',
    };
    const { context, tradeClient } = createContext({ generateResult: { query: pobQuery } });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    });

    expect(tradeClient.searchItems).toHaveBeenCalledWith('Standard', {
      ...pobQuery,
      sort: { price: 'asc' },
    });
    expect(result.content[0].text).toContain('No items found');
    expect(result.content[0].text).toContain('Query had 1 weighted mods');
    expect(result.content[0].text).toContain('Query shape: category=accessory.belt');
    expect(result.content[0].text).toContain('Weighted filters: 1 total, first weighted group: 1');
  });

  it('surfaces the sanitized POE_SESSION_ID diagnostic without leaking the full value', async () => {
    const fullSessionId = 'abcd1234efgh5678ijkl9012mnop3456';
    process.env.POE_SESSION_ID = fullSessionId;
    const pobQuery = buildWeightedQuery(
      [{ id: 'explicit.stat_123', value: { weight: 1.5 } }],
      'accessory.belt',
    );
    const { context } = createContext({ generateResult: { query: pobQuery } });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    });

    expect(result.content[0].text).toContain('POE_SESSION_ID configured: yes');
    expect(result.content[0].text).toContain('length=32');
    expect(result.content[0].text).toContain('fingerprint=abcd...3456');
    expect(result.content[0].text).not.toContain(fullSessionId);
  });

  it("normalizes Watcher's Eye special into final query name/type/rarity constraints", async () => {
    const pobQuery = buildWeightedQuery(
      [{ id: 'explicit.stat_123', value: { weight: 1.5 } }],
      'jewel',
    );
    (pobQuery.query as any).name = 'Bad Name';
    (pobQuery.query as any).type = 'Bad Type';
    const { context, luaClient, tradeClient } = createContext({ generateResult: { query: pobQuery } });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Jewel 12613',
      options: { special: { itemName: "Watcher's Eye" } },
    });

    expect(luaClient.generateWeightedTradeQuery).toHaveBeenCalledWith('Jewel 12613', undefined);
    const postedQuery: any = tradeClient.searchItems.mock.calls[0]?.[1];
    expect(postedQuery.query.name).toBe("Watcher's Eye");
    expect(postedQuery.query.type).toBe('Prismatic Jewel');
    expect(postedQuery.query.filters.type_filters.filters.rarity).toEqual({ option: 'unique' });
    expect(postedQuery.query.filters.type_filters.filters.category).toEqual({ option: 'jewel' });
    expect(result.content[0].text).toContain('constrained the final trade query to unique Watcher');
  });

  it('keeps PoB-supported Megalomaniac special passthrough unchanged', async () => {
    const pobQuery = buildWeightedQuery([], 'jewel');
    const { context, luaClient } = createContext({ generateResult: { query: pobQuery } });
    const options = { special: { itemName: 'Megalomaniac' } };

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Jewel 29712',
      options,
    });

    expect(luaClient.generateWeightedTradeQuery).toHaveBeenCalledWith('Jewel 29712', options);
  });

  it('labels unknown PoB slots as slot resolution failures', async () => {
    const luaClient = {
      generateWeightedTradeQuery: jest
        .fn()
        .mockRejectedValue(new Error('unknown slot: Cape') as never),
      rankTradeResults: jest.fn(),
    };
    const context = {
      tradeClient: {
        searchItems: jest.fn(),
        fetchItems: jest.fn(),
      },
      ensureLuaClient: jest.fn().mockResolvedValue(undefined as never),
      getLuaClient: jest.fn(() => luaClient),
    } as any;

    await expect(
      handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Cape',
      }),
    ).rejects.toThrow(/slot resolution failed: unknown slot: Cape/);

    expect(context.tradeClient.searchItems).not.toHaveBeenCalled();
    expect(luaClient.rankTradeResults).not.toHaveBeenCalled();
  });

  it('labels trade API failures separately from PoB query generation', async () => {
    const { context, tradeClient } = createContext({
      generateResult: {
        query: {
          query: { stats: [{ type: 'weight', filters: [] }] },
          sort: { price: 'asc' },
        },
      },
    });
    tradeClient.searchItems.mockRejectedValue(new Error('rate limited') as never);

    await expect(
      handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Belt',
      }),
    ).rejects.toThrow(/trade API query failed for slot "Belt": rate limited/);
  });

  it('surfaces POE_SESSION_ID diagnostics for anonymous weighted query-too-complex failures without retrying', async () => {
    delete process.env.POE_SESSION_ID;
    const pobQuery = buildWeightedQuery([
      weightedFilter('explicit.stat_life', 1),
      weightedFilter('explicit.stat_resistance', 0.5),
    ]);
    const { context, tradeClient, luaClient } = createContext({
      generateResult: { query: pobQuery },
    });
    tradeClient.searchItems.mockRejectedValue(new Error('Query is too complex') as never);

    await expect(
      handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Belt',
      }),
    ).rejects.toThrow(/POE_SESSION_ID/);

    expect(tradeClient.searchItems).toHaveBeenCalledTimes(1);
    expect(luaClient.rankTradeResults).not.toHaveBeenCalled();
  });

  it('retries authenticated query-too-complex failures with top absolute weighted filters', async () => {
    process.env.POE_SESSION_ID = 'test-session';
    const pobQuery = buildWeightedQuery([
      weightedFilter('positive_medium', 1.5),
      weightedFilter('negative_large', -2.0),
      weightedFilter('missing_weight'),
      ...Array.from({ length: 19 }, (_, i) => weightedFilter(`high_${i}`, 3 + i)),
    ]);
    const fetched = [
      buildListing({
        id: 'a',
        name: 'Fallback Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nFallback Belt\nHeavy Belt\n',
        priceAmount: 10,
      }),
    ];
    const { context, tradeClient, luaClient } = createContext({
      generateResult: { query: pobQuery },
      fetchedItems: fetched,
      rankResult: {
        ranked: [{ index: 1, weight: 0.2, deltas: { FullDPS: 100 } }],
        sortMode: 'StatValue',
      },
    });
    tradeClient.searchItems
      .mockRejectedValueOnce(new Error('Query is too complex') as never)
      .mockResolvedValueOnce({ id: 'fallback-search', total: 1, result: ['a'] } as never);

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    });

    expect(tradeClient.searchItems).toHaveBeenCalledTimes(2);
    const fallbackQuery: any = tradeClient.searchItems.mock.calls[1]?.[1];
    const fallbackFilters = fallbackQuery.query.stats[0].filters;
    const fallbackIds = fallbackFilters.map((filter: any) => filter.id);
    expect(fallbackFilters).toHaveLength(20);
    expect(fallbackIds).toContain('negative_large');
    expect(fallbackIds).not.toContain('positive_medium');
    expect(fallbackIds).not.toContain('missing_weight');
    expect(fallbackQuery.sort).toEqual({ price: 'asc' });
    expect(luaClient.rankTradeResults).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('retried with top 20 of 22 weighted filters');
    expect(result.content[0].text).toContain('winning cap 20; attempted caps: [20]');
    expect(result.content[0].text).toContain('Candidate pool is a narrowed subset');
  });

  it('continues query-too-complex fallback to the next smaller cap', async () => {
    process.env.POE_SESSION_ID = 'test-session';
    const pobQuery = buildWeightedQuery(
      Array.from({ length: 22 }, (_, i) => weightedFilter(`stat_${i}`, i + 1)),
      'accessory.ring',
    );
    const fetched = [
      buildListing({
        id: 'a',
        name: 'Fallback Ring',
        typeLine: 'Amethyst Ring',
        itemText: 'Item Class: Rings\nRarity: Rare\nFallback Ring\nAmethyst Ring\n',
        priceAmount: 10,
      }),
    ];
    const { context, tradeClient } = createContext({
      generateResult: { query: pobQuery },
      fetchedItems: fetched,
      rankResult: {
        ranked: [{ index: 1, weight: 0.2, deltas: { FullDPS: 100 } }],
        sortMode: 'StatValue',
      },
    });
    tradeClient.searchItems
      .mockRejectedValueOnce(new Error('Query is too complex') as never)
      .mockRejectedValueOnce(new Error('Query is too complex at 20') as never)
      .mockResolvedValueOnce({ id: 'fallback-search', total: 1, result: ['a'] } as never);

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Ring 1',
    });

    expect(tradeClient.searchItems).toHaveBeenCalledTimes(3);
    const cap20Query: any = tradeClient.searchItems.mock.calls[1]?.[1];
    const cap15Query: any = tradeClient.searchItems.mock.calls[2]?.[1];
    expect(cap20Query.query.stats[0].filters).toHaveLength(20);
    expect(cap15Query.query.stats[0].filters).toHaveLength(15);
    expect(result.content[0].text).toContain('winning cap 15; attempted caps: [20, 15]');
  });

  it('reports original and per-cap fallback diagnostics when all retries fail', async () => {
    const fullSessionId = 'abcd1234efgh5678ijkl9012mnop3456';
    process.env.POE_SESSION_ID = fullSessionId;
    const pobQuery = buildWeightedQuery(
      Array.from({ length: 21 }, (_, i) => weightedFilter(`stat_${i}`, i + 1)),
      'accessory.ring',
    );
    const { context, tradeClient, luaClient } = createContext({
      generateResult: { query: pobQuery },
    });
    tradeClient.searchItems.mockRejectedValue(new Error('Query is too complex after fallback') as never);

    let thrown: Error | undefined;
    try {
      await handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Ring 1',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('All top-N weighted fallback caps failed');
    expect(thrown?.message).toContain('Attempted fallback caps: [20, 15, 10, 5]');
    expect(thrown?.message).toContain('cap 20: kept 20 of 21 weighted filters');
    expect(thrown?.message).toContain('cap 15: kept 15 of 21 weighted filters');
    expect(thrown?.message).toContain('cap 10: kept 10 of 21 weighted filters');
    expect(thrown?.message).toContain('cap 5: kept 5 of 21 weighted filters');
    expect(thrown?.message).toContain('Original diagnostics');
    expect(thrown?.message).toContain('Final fallback diagnostics');
    expect(thrown?.message).toContain('fingerprint=abcd...3456');
    expect(thrown?.message).not.toContain(fullSessionId);
    expect(thrown?.message).toContain('category=accessory.ring');
    expect(tradeClient.searchItems).toHaveBeenCalledTimes(5);
    expect(luaClient.rankTradeResults).not.toHaveBeenCalled();
  });

  it('skips fallback caps that do not reduce the weighted filter count', async () => {
    process.env.POE_SESSION_ID = 'test-session';
    const pobQuery = buildWeightedQuery(
      Array.from({ length: 12 }, (_, i) => weightedFilter(`stat_${i}`, i + 1)),
      'accessory.ring',
    );
    const { context, tradeClient } = createContext({
      generateResult: { query: pobQuery },
    });
    tradeClient.searchItems.mockRejectedValue(new Error('Query is too complex') as never);

    let thrown: Error | undefined;
    try {
      await handleFindWeightedTradeItems(context, {
        league: 'Standard',
        slot: 'Ring 1',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(tradeClient.searchItems).toHaveBeenCalledTimes(3);
    expect(thrown?.message).toContain('Attempted fallback caps: [10, 5]');
    expect(thrown?.message).not.toContain('cap 20:');
    expect(thrown?.message).not.toContain('cap 15:');
    const cap10Query: any = tradeClient.searchItems.mock.calls[1]?.[1];
    const cap5Query: any = tradeClient.searchItems.mock.calls[2]?.[1];
    expect(cap10Query.query.stats[0].filters).toHaveLength(10);
    expect(cap5Query.query.stats[0].filters).toHaveLength(5);
  });

  it('passes decoded item_strings + sortMode to PoB ranking and reorders output by ranked order', async () => {
    const pobQuery = {
      query: { stats: [{ type: 'weight', filters: [{ id: 'x', value: { weight: 1 } }] }] },
      sort: { 'statgroup.0': 'desc' },
    };
    const fetched = [
      buildListing({
        id: 'low',
        name: 'Low Belt',
        typeLine: 'Stygian Vise',
        itemText: 'Item Class: Belts\nRarity: Rare\nLow Belt\nStygian Vise\n',
        priceAmount: 5,
      }),
      buildListing({
        id: 'high',
        name: 'High Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nHigh Belt\nHeavy Belt\n',
        priceAmount: 50,
      }),
      buildListing({
        id: 'mid',
        name: 'Mid Belt',
        typeLine: 'Cloth Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nMid Belt\nCloth Belt\n',
        priceAmount: 15,
      }),
    ];
    const { context, luaClient } = createContext({
      generateResult: { query: pobQuery },
      searchResult: { id: 'srch1', total: 3, result: ['low', 'high', 'mid'] },
      fetchedItems: fetched,
      rankResult: {
        // PoB returns items ranked by impact; "high" wins, "mid" second, "low" last.
        ranked: [
          { index: 2, weight: 0.42, deltas: { FullDPS: 1234.5, TotalEHP: 200 } },
          { index: 3, weight: 0.18, deltas: { FullDPS: 480.0, TotalEHP: 120 } },
          { index: 1, weight: 0.07, deltas: { FullDPS: 110.0, TotalEHP: 30 } },
        ],
        sortMode: 'StatValue',
      },
    });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      sortMode: 'StatValue',
      limit: 3,
    });

    expect(luaClient.rankTradeResults).toHaveBeenCalledTimes(1);
    const rankCall: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(rankCall.slot).toBe('Belt');
    expect(rankCall.sortMode).toBe('StatValue');
    expect(rankCall.items).toHaveLength(3);
    // item_string should be the decoded base64
    expect(rankCall.items[0].item_string).toContain('Low Belt');
    expect(rankCall.items[1].item_string).toContain('High Belt');
    expect(rankCall.items[2].item_string).toContain('Mid Belt');
    // price metadata passed through, with chaos-equivalent populated for chaos-priced items
    expect(rankCall.items[0].price).toEqual({ amount: 5, currency: 'chaos', chaos: 5 });

    const text = result.content[0].text;
    // Output reordered: High Belt should be #1, Mid #2, Low #3
    const highIdx = text.indexOf('High Belt');
    const midIdx = text.indexOf('Mid Belt');
    const lowIdx = text.indexOf('Low Belt');
    expect(highIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);

    // Impact line should be present with the deltas
    expect(text).toContain('Impact:');
    expect(text).toContain('FullDPS');
    expect(text).toContain('Weighted score:');
    expect(text).toContain('build-impact ranked locally via PoB');
    expect(text).toContain('Ranked: 3/3');
  });

  it('falls back to fetch order with a warning when PoB ranking fails', async () => {
    const fetched = [
      buildListing({
        id: 'a',
        name: 'A Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nA Belt\nHeavy Belt\n',
        priceAmount: 5,
      }),
      buildListing({
        id: 'b',
        name: 'B Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nB Belt\nHeavy Belt\n',
        priceAmount: 8,
      }),
    ];
    const { context } = createContext({
      generateResult: {
        query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { 'statgroup.0': 'desc' } },
      },
      searchResult: { id: 'srch2', total: 2, result: ['a', 'b'] },
      fetchedItems: fetched,
      rankRejection: new Error('miscCalculator missing'),
    });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    });

    const text = result.content[0].text;
    expect(text).toContain('PoB ranking failed: miscCalculator missing');
    // Falls back to fetch order: A then B
    const aIdx = text.indexOf('A Belt');
    const bIdx = text.indexOf('B Belt');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it('warns when PoB downgraded the requested sort (e.g. StatValuePrice → StatValue when prices missing)', async () => {
    const fetched = [
      buildListing({
        id: 'p',
        name: 'P Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nP Belt\nHeavy Belt\n',
      }),
    ];
    const { context } = createContext({
      generateResult: {
        query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } },
      },
      searchResult: { id: 'srch3', total: 1, result: ['p'] },
      fetchedItems: fetched,
      rankResult: {
        ranked: [{ index: 1, weight: 0.05, deltas: { FullDPS: 50 } }],
        sortMode: 'StatValue', // PoB downgraded from requested StatValuePrice
      },
    });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      sortMode: 'StatValuePrice',
    });

    expect(result.content[0].text).toContain(
      'Requested sort "StatValuePrice" fell back to "StatValue"',
    );
  });

  it('passes chaos-equivalent prices to ranker for chaos-priced listings (StatValuePrice success path)', async () => {
    const fetched = [
      buildListing({
        id: 'cheap',
        name: 'Cheap Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nCheap Belt\nHeavy Belt\n',
        priceAmount: 5,
        priceCurrency: 'chaos',
      }),
      buildListing({
        id: 'pricey',
        name: 'Pricey Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nPricey Belt\nHeavy Belt\n',
        priceAmount: 100,
        priceCurrency: 'chaos',
      }),
    ];
    const { context, luaClient, ninjaClient } = createContext({
      generateResult: {
        query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } },
      },
      searchResult: { id: 'srch4', total: 2, result: ['cheap', 'pricey'] },
      fetchedItems: fetched,
      rankResult: {
        ranked: [
          { index: 1, weight: 0.1, deltas: { FullDPS: 100 }, price: { amount: 5, currency: 'chaos', chaos: 5 } },
          { index: 2, weight: 0.5, deltas: { FullDPS: 800 }, price: { amount: 100, currency: 'chaos', chaos: 100 } },
        ],
        sortMode: 'StatValuePrice',
      },
    });

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      sortMode: 'StatValuePrice',
    });

    expect(luaClient.rankTradeResults).toHaveBeenCalledTimes(1);
    const call: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(call.sortMode).toBe('StatValuePrice');
    // Both items chaos-priced — caller should populate chaos field directly
    // without needing a ninjaClient round-trip.
    expect(call.items[0].price).toEqual({ amount: 5, currency: 'chaos', chaos: 5 });
    expect(call.items[1].price).toEqual({ amount: 100, currency: 'chaos', chaos: 100 });
    // No ninjaClient was provided AND no non-chaos items, so no rates fetch.
    expect(ninjaClient).toBeUndefined();
  });

  it('uses ninjaClient to convert non-chaos prices for Price sort', async () => {
    const fetched = [
      buildListing({
        id: 'div',
        name: 'Div Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nDiv Belt\nHeavy Belt\n',
        priceAmount: 2,
        priceCurrency: 'div',
      }),
      buildListing({
        id: 'cha',
        name: 'Cha Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nCha Belt\nHeavy Belt\n',
        priceAmount: 50,
        priceCurrency: 'chaos',
      }),
    ];
    const { context, luaClient, ninjaClient } = createContext({
      generateResult: { query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } } },
      searchResult: { id: 'srch5', total: 2, result: ['div', 'cha'] },
      fetchedItems: fetched,
      rankResult: {
        ranked: [
          { index: 2, weight: 0, deltas: {}, price: { amount: 50, currency: 'chaos', chaos: 50 } },
          { index: 1, weight: 0, deltas: {}, price: { amount: 2, currency: 'div', chaos: 200 } },
        ],
        sortMode: 'Price',
      },
      ninjaRates: new Map([
        ['Chaos Orb', 1.0],
        ['Divine Orb', 100.0],
      ]),
    });

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      sortMode: 'Price',
    });

    expect(ninjaClient!.getCurrencyExchangeMap).toHaveBeenCalledWith('Standard');
    const call: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(call.items[0].price.chaos).toBe(200); // 2 div × 100 chaos/div
    expect(call.items[1].price.chaos).toBe(50);  // chaos pass-through
  });

  it('skips ninjaClient call when all listings are chaos-priced', async () => {
    const fetched = [
      buildListing({
        id: 'a',
        name: 'A Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nA Belt\nHeavy Belt\n',
        priceAmount: 5,
        priceCurrency: 'chaos',
      }),
    ];
    const ninjaSpy = jest.fn();
    const { context, luaClient } = createContext({
      generateResult: { query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } } },
      searchResult: { id: 'srch6', total: 1, result: ['a'] },
      fetchedItems: fetched,
      rankResult: { ranked: [{ index: 1, weight: 0, deltas: {} }], sortMode: 'Price' },
    });
    // Inject a spying ninjaClient post-construction
    context.ninjaClient = { getCurrencyExchangeMap: ninjaSpy };

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      sortMode: 'Price',
    });

    expect(ninjaSpy).not.toHaveBeenCalled();
    const call: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(call.items[0].price.chaos).toBe(5);
  });

  it('forwards user-supplied options.statWeights to the local ranker', async () => {
    const fetched = [
      buildListing({
        id: 'a',
        name: 'A Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nA Belt\nHeavy Belt\n',
        priceAmount: 5,
      }),
    ];
    const { context, luaClient } = createContext({
      generateResult: { query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } } },
      searchResult: { id: 'srch7', total: 1, result: ['a'] },
      fetchedItems: fetched,
      rankResult: { ranked: [{ index: 1, weight: 0.2, deltas: { Life: 50 } }], sortMode: 'StatValue' },
    });

    const customWeights = [
      { stat: 'Life', label: 'Life', weightMult: 1.0 },
      { stat: 'TotalEHP', label: 'EHP', weightMult: 0.25 },
    ];

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      options: { statWeights: customWeights },
    });

    const call: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(call.statWeights).toEqual(customWeights);
  });

  it('drops malformed options.statWeights instead of forwarding to PoB', async () => {
    const fetched = [
      buildListing({
        id: 'a',
        name: 'A Belt',
        typeLine: 'Heavy Belt',
        itemText: 'Item Class: Belts\nRarity: Rare\nA Belt\nHeavy Belt\n',
        priceAmount: 5,
      }),
    ];
    const { context, luaClient } = createContext({
      generateResult: { query: { query: { stats: [{ type: 'weight', filters: [] }] }, sort: { price: 'asc' } } },
      searchResult: { id: 'srch8', total: 1, result: ['a'] },
      fetchedItems: fetched,
      rankResult: { ranked: [{ index: 1, weight: 0.2, deltas: {} }], sortMode: 'StatValue' },
    });

    await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
      options: { statWeights: [{ stat: 'Life' /* missing weightMult */ }] },
    });

    const call: any = luaClient.rankTradeResults.mock.calls[0]?.[0];
    expect(call.statWeights).toBeUndefined();
  });
});
