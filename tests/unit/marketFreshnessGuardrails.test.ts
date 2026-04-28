import { describe, expect, it, jest } from '@jest/globals';
import { handleGetItemPrice } from '../../src/handlers/tradeHandlers.js';
import { formatShoppingList } from '../../src/handlers/shoppingListHandlers.js';
import { CostBenefitAnalyzer } from '../../src/services/costBenefitAnalyzer.js';
import type { ItemListing, TradePrice } from '../../src/types/tradeTypes.js';

function makeListing(id: string, price?: TradePrice): ItemListing {
  return {
    id,
    listing: {
      method: 'psapi',
      indexed: '2026-04-28T00:00:00Z',
      whisper: '@seller test',
      account: {
        name: `seller-${id}`,
        online: { league: 'Mirage' },
      },
      price,
    },
    item: {
      verified: true,
      w: 1,
      h: 1,
      icon: '',
      league: 'Mirage',
      id,
      name: '',
      typeLine: 'Test Ring',
      baseType: 'Ring',
      identified: true,
      ilvl: 85,
      frameType: 2,
      explicitMods: ['+80 to maximum Life', '+45% to Fire Resistance'],
    },
  };
}

describe('market freshness guardrails', () => {
  it('adds live source, league, timestamp, sample size, and thin-market warning to price checks', async () => {
    const tradeClient = {
      searchItems: jest.fn(async () => ({
        id: 'search123',
        complexity: 1,
        result: ['item1', 'item2'],
        total: 2,
      })),
      fetchItems: jest.fn(async () => [
        makeListing('item1', { type: '~price', amount: 10, currency: 'chaos' }),
        makeListing('item2', { type: '~price', amount: 12, currency: 'chaos' }),
      ]),
    };

    const result = await handleGetItemPrice({ tradeClient } as any, {
      item_name: 'Eclipse Solaris',
      league: 'Mirage',
    });
    const text = result.content[0].text;

    expect(text).toContain('Source: Path of Exile Trade API live search');
    expect(text).toContain('League: Mirage');
    expect(text).toContain('Retrieved At:');
    expect(text).toContain('Search ID: search123');
    expect(text).toContain('Total Listings: 2');
    expect(text).toContain('Priced Sample: 2/2 listings');
    expect(text).toContain('Warning: thin market or low priced sample');
  });

  it('does not use static currency fallbacks for non-chaos value scoring', () => {
    const analyzer = new CostBenefitAnalyzer();
    const analysis = analyzer.analyzeItem(
      makeListing('item1', { type: '~price', amount: 1, currency: 'divine' }),
      new Map()
    );

    expect(analysis.priceInChaos).toBe(0);
    expect(analysis.metrics.valueScore).toBe(0);
    expect(analysis.metrics.isBudgetPick).toBe(false);
    expect(analysis.metrics.warnings).toContain(
      'No live chaos-equivalent price available - value metrics unavailable'
    );
  });

  it('does not emit numeric shopping-list prices without live trade data', () => {
    const text = formatShoppingList({
      buildName: 'test-build.xml',
      league: 'Mirage',
      summary: {
        totalItems: 1,
        criticalUpgrades: 0,
        totalBudgetCost: 12,
        totalMediumCost: 60,
        totalEndgameCost: 300,
      },
      buildNeeds: {
        lifeNeeded: 0,
        resistanceGaps: { fire: 0, cold: 0, lightning: 0, chaos: 0 },
      },
      priorities: {
        immediate: ['Boots'],
        shortTerm: [],
        longTerm: [],
      },
      items: [{
        slot: 'Boots',
        reason: ['needs movement speed'],
        recommendations: {
          budget: {
            searchCriteria: 'Boots with life and resistances',
            estimatedPrice: { min: 5, max: 20, currency: 'chaos' },
            keyStats: ['+60 Life'],
          },
          medium: {
            searchCriteria: 'Boots with high life and tri-res',
            estimatedPrice: { min: 20, max: 100, currency: 'chaos' },
            keyStats: ['+80 Life'],
          },
          endgame: {
            searchCriteria: 'Boots with T1 life and tri-res',
            estimatedPrice: { min: 100, max: 500, currency: 'chaos' },
            keyStats: ['+100 Life'],
          },
        },
      }],
    }, 'medium');

    expect(text).toContain('Market Price Status: Not live-checked by this tool');
    expect(text).toContain('Price: not live-checked');
    expect(text).not.toContain('Budget Cost: ~');
    expect(text).not.toContain('Est. Cost');
    expect(text).not.toContain('20-100 chaos');
  });
});
