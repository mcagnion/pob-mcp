import { handleAnalyzeChargeEconomy } from '../../src/handlers/chargeEconomyHandlers';

describe('charge economy handler', () => {
  function makeContext(overrides: Partial<any> = {}) {
    const luaClient = {
      getStats: jest.fn().mockResolvedValue({
        PowerCharges: 5,
        PowerChargesMin: 1,
        PowerChargesMax: 5,
        FrenzyCharges: 3,
        FrenzyChargesMin: 0,
        FrenzyChargesMax: 3,
        EnduranceCharges: 0,
        EnduranceChargesMin: 0,
        EnduranceChargesMax: 3,
      }),
      getConfig: jest.fn().mockResolvedValue({
        usePowerCharges: true,
        useFrenzyCharges: true,
        useEnduranceCharges: false,
      }),
      getItems: jest.fn().mockResolvedValue([
        {
          slot: 'Ring 1',
          name: 'Woe Band',
          raw: [
            'Rarity: Rare',
            'Woe Band',
            'Two-Stone Ring',
            'Implicits: 1',
            '+16% to Fire and Cold Resistances',
            '+1 to Minimum Power Charges',
          ].join('\n'),
        },
      ]),
      searchNodes: jest.fn(async ({ keyword }: { keyword: string }) => {
        if (/Power/.test(keyword)) {
          return {
            nodes: [
              {
                id: 123,
                name: 'Disciple of the Forbidden',
                allocated: true,
                type: 'notable',
                stats: ['+1 to Minimum Power Charges', '8% increased Damage per Power Charge'],
              },
              {
                id: 456,
                name: 'Unallocated Power Node',
                allocated: false,
                type: 'notable',
                stats: ['+1 to Maximum Power Charges'],
              },
            ],
          };
        }
        return { nodes: [] };
      }),
      ...overrides,
    };

    return {
      luaClient,
      context: {
        ensureLuaClient: jest.fn().mockResolvedValue(undefined),
        getLuaClient: jest.fn(() => luaClient),
      },
    };
  }

  it('reports charge stats, config, allocated passive sources, and item sources', async () => {
    const { context, luaClient } = makeContext();

    const result = await handleAnalyzeChargeEconomy(context as any, 'power');
    const text = result.content[0].text;

    expect(text).toContain('=== Charge Economy Analysis ===');
    expect(text).toContain('Freshness marker: retrievedAt=');
    expect(text).toContain('--- Power Charges ---');
    expect(text).toContain('Stats: current=5, min=1, max=5');
    expect(text).toContain('Config toggle usePowerCharges: enabled');
    expect(text).toContain('Disciple of the Forbidden [123]');
    expect(text).toContain('+1 to Minimum Power Charges');
    expect(text).not.toContain('Unallocated Power Node [456]');
    expect(text).toContain('Ring 1: Woe Band');
    expect(text).toContain('Use this before answering where charges come from');

    expect(luaClient.searchNodes).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'Power Charge',
      includeAllocated: true,
    }));
  });

  it('rejects unknown charge types', async () => {
    const { context } = makeContext();

    await expect(handleAnalyzeChargeEconomy(context as any, 'rage')).rejects.toThrow(
      'Unknown charge_type "rage"'
    );
  });

  it('labels absent charge toggles without implying they were read', async () => {
    const { context } = makeContext({
      getConfig: jest.fn().mockResolvedValue({}),
    });

    const result = await handleAnalyzeChargeEconomy(context as any, 'power');
    const text = result.content[0].text;

    expect(text).toContain('Config toggle usePowerCharges: not present in config input');
  });
});
