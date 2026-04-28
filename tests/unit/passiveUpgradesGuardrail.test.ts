import { handleGetPassiveUpgrades } from '../../src/handlers/treeHandlers';

describe('passive upgrades guardrails', () => {
  function makeContext(searchNodes = jest.fn().mockResolvedValue({ nodes: [] })) {
    const luaClient = {
      getStats: jest.fn().mockResolvedValue({
        Life: 4500,
        EnergyShield: 1000,
        Mana: 900,
        ManaUnreserved: 100,
        FireResist: 75,
        ColdResist: 75,
        LightningResist: 75,
        ChaosResist: 0,
        FireResistOverCap: 0,
        ColdResistOverCap: 0,
        LightningResistOverCap: 0,
        SpellSuppressionChance: 0,
        EffectiveSpellSuppressionChance: 0,
        TotalDPS: 1000,
        CombinedDPS: 1000,
        MinionTotalDPS: 0,
        TotalEHP: 10000,
      }),
      getBuildInfo: jest.fn().mockResolvedValue({ level: 90 }),
      getTree: jest.fn().mockResolvedValue({
        nodes: Array.from({ length: 114 }, (_, index) => index + 1),
        ascendancyPointsUsed: 8,
      }),
      getItems: jest.fn().mockResolvedValue([]),
      getSkills: jest.fn().mockResolvedValue({ groups: [] }),
      searchNodes,
      calcWith: jest.fn().mockResolvedValue({
        CombinedDPS: 1100,
        TotalEHP: 10000,
      }),
    };

    return {
      luaClient,
      context: {
        ensureLuaClient: jest.fn().mockResolvedValue(undefined),
        getLuaClient: jest.fn(() => luaClient),
      },
    };
  }

  it('prints guardrails before passive upgrade results', async () => {
    const searchNodes = jest.fn(async ({ keyword }: { keyword: string }) => {
      if (keyword === 'damage') {
        return {
          nodes: [
            {
              id: 123,
              name: 'Damage Notable',
              stats: ['10% increased Damage'],
            },
          ],
        };
      }
      return { nodes: [] };
    });
    const { context } = makeContext(searchNodes);

    const result = await handleGetPassiveUpgrades(context as any, 'dps', 3);
    const text = result.content[0].text;

    expect(text).toContain('Guardrail: heuristic next-node scanner only');
    expect(text).toContain('Guardrail: do NOT use this for anointments. Use find_best_anointment');
    expect(text).toContain('candidates come from a small keyword search');
    expect(text).toContain('Damage Notable');
    expect(text).toContain('Next steps: inspect the top node with search_tree_nodes/find_path_to_node');
  });

  it('prints guardrails when no candidates are found', async () => {
    const { context } = makeContext();

    const result = await handleGetPassiveUpgrades(context as any, 'both', 3);
    const text = result.content[0].text;

    expect(text).toContain('Guardrail: heuristic next-node scanner only');
    expect(text).toContain('No unallocated notable candidates found');
  });
});
