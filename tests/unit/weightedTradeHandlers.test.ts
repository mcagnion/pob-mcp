import { describe, expect, it, jest } from '@jest/globals';
import { handleFindWeightedTradeItems } from '../../src/handlers/tradeHandlers.js';

function createContext(generateResult: unknown) {
  const luaClient = {
    generateWeightedTradeQuery: jest.fn().mockResolvedValue(generateResult as never),
  };
  const tradeClient = {
    searchItems: jest.fn().mockResolvedValue({
      id: 'abc123',
      total: 0,
      result: [],
    } as never),
    fetchItems: jest.fn(),
  };

  return {
    context: {
      tradeClient,
      ensureLuaClient: jest.fn().mockResolvedValue(undefined as never),
      getLuaClient: jest.fn(() => luaClient),
    } as any,
    luaClient,
    tradeClient,
  };
}

describe('handleFindWeightedTradeItems', () => {
  it('rejects Watcher\'s Eye as a slot name before calling PoB', async () => {
    const { context, luaClient, tradeClient } = createContext({ query: {} });

    await expect(handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: "Watcher's Eye",
    })).rejects.toThrow(/unique item name, not an equipped PoB slot/);

    expect(luaClient.generateWeightedTradeQuery).not.toHaveBeenCalled();
    expect(tradeClient.searchItems).not.toHaveBeenCalled();
  });

  it('converts PoB statgroup sort to a trade API supported sort with warning', async () => {
    const pobQuery = {
      query: {
        stats: [
          {
            type: 'weight',
            filters: [
              { id: 'explicit.stat_123', value: { weight: 1.5 } },
            ],
          },
        ],
      },
      sort: { 'statgroup.0': 'desc' },
      engine: 'new',
    };
    const { context, tradeClient } = createContext({ query: pobQuery });

    const result = await handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    });

    expect(tradeClient.searchItems).toHaveBeenCalledWith('Standard', {
      ...pobQuery,
      sort: { price: 'asc' },
    });
    expect(result.content[0].text).toContain('Falling back to price ascending');
    expect(result.content[0].text).toContain('weighted-filter candidates');
    expect(result.content[0].text).toContain('Query had 1 weighted mods');
  });

  it('labels unknown PoB slots as slot resolution failures', async () => {
    const luaClient = {
      generateWeightedTradeQuery: jest.fn().mockRejectedValue(new Error('unknown slot: Cape') as never),
    };
    const context = {
      tradeClient: {
        searchItems: jest.fn(),
        fetchItems: jest.fn(),
      },
      ensureLuaClient: jest.fn().mockResolvedValue(undefined as never),
      getLuaClient: jest.fn(() => luaClient),
    } as any;

    await expect(handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Cape',
    })).rejects.toThrow(/slot resolution failed: unknown slot: Cape/);

    expect(context.tradeClient.searchItems).not.toHaveBeenCalled();
  });

  it('labels trade API failures separately from PoB query generation', async () => {
    const { context, tradeClient } = createContext({
      query: {
        query: { stats: [{ type: 'weight', filters: [] }] },
        sort: { price: 'asc' },
      },
    });
    tradeClient.searchItems.mockRejectedValue(new Error('rate limited') as never);

    await expect(handleFindWeightedTradeItems(context, {
      league: 'Standard',
      slot: 'Belt',
    })).rejects.toThrow(/trade API query failed for slot "Belt": rate limited/);
  });
});
