import { describe, it, expect, jest } from '@jest/globals';
import { handleAnalyzeConfigAssumptions } from '../../src/handlers/configAssumptionHandlers';
import { CONFIG_ASSUMPTION_PROFILE_VALUES } from '../../src/data/configAssumptionProfiles';

function makeLuaClient(overrides: Record<string, any> = {}) {
  return {
    getConfig: jest.fn<() => Promise<any>>().mockResolvedValue({
      usePowerCharges: false,
      useFrenzyCharges: false,
      useEnduranceCharges: false,
      useSiphoningCharges: false,
      ...overrides.config,
    }),
    getItems: jest.fn<() => Promise<any[]>>().mockResolvedValue(overrides.items ?? []),
    getSkills: jest.fn<() => Promise<any>>().mockResolvedValue(overrides.skills ?? { groups: [] }),
    getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue(overrides.buildInfo ?? { name: 'Fixture Build', pobVersion: '2.50.0' }),
    setConfig: jest.fn<() => Promise<any>>().mockResolvedValue({}),
    setFlaskActive: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveBuild: jest.fn<() => Promise<any>>().mockResolvedValue({}),
    ...overrides.methods,
  };
}

function makeContext(luaClient: any, ensureLuaClient = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  return {
    getLuaClient: () => luaClient,
    ensureLuaClient,
  };
}

async function analyze(overrides: Record<string, any> = {}, profile?: string) {
  const luaClient = makeLuaClient(overrides);
  const result = await handleAnalyzeConfigAssumptions(makeContext(luaClient), { profile });
  return {
    luaClient,
    output: JSON.parse(result.content[0].text),
  };
}

describe('handleAnalyzeConfigAssumptions', () => {
  it('returns a stable structured fixture with direct evidence categories', async () => {
    const { output } = await analyze({
      config: {
        usePowerCharges: true,
        conditionEnemyShocked: true,
        multiplierRage: 30,
        customMods: '20% more Damage\nEnemy takes 10% increased Damage',
      },
      items: [
        { id: 1, slot: 'Flask 1', name: 'Diamond Flask', active: true },
      ],
      skills: {
        groups: [
          {
            enabled: true,
            gems: [
              { name: 'Vaal Fireball', enabled: true },
            ],
          },
        ],
      },
    }, 'hc_trade_bossing');

    expect(output).toMatchObject({
      schema_version: '0.1',
      tool: 'analyze_config_assumptions',
      profile: 'hc_trade_bossing',
      build: {
        name: 'Fixture Build',
        pob_version: '2.50.0',
      },
    });

    expect(output.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'flasks.active',
          data_kind: 'direct_from_pob',
          classification: 'flask_dependent',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'charges.usePowerCharges.enabled',
          data_kind: 'direct_from_pob_config',
          classification: 'conditional',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'customMods.present',
          classification: 'needs_verification',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'skills.vaal.enabled',
          classification: 'burst_only',
          data_kind: 'direct_from_pob',
        }),
      ])
    );
    expect(output.summary.warning_count).toBeGreaterThanOrEqual(1);
    for (const assumption of output.assumptions) {
      expect(assumption).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          state: expect.any(String),
          classification: expect.any(String),
          severity: expect.any(String),
          confidence: expect.any(String),
          data_kind: expect.any(String),
          evidence: expect.any(Array),
          impact: expect.any(String),
          suggested_next_test: expect.any(String),
        })
      );
    }
  });

  it('applies profile severity differences from the profile table', async () => {
    const shared = {
      config: {
        usePowerCharges: true,
      },
      items: [
        { id: 1, slot: 'Flask 1', name: 'Diamond Flask', active: true },
      ],
    };

    const mapping = await analyze(shared, 'sc_trade_mapping');
    const bossing = await analyze(shared, 'hc_trade_bossing');

    const mappingFlask = mapping.output.assumptions.find((item: any) => item.id === 'flasks.active');
    const bossingFlask = bossing.output.assumptions.find((item: any) => item.id === 'flasks.active');
    const mappingCharge = mapping.output.assumptions.find((item: any) => item.id === 'charges.usePowerCharges.enabled');
    const bossingCharge = bossing.output.assumptions.find((item: any) => item.id === 'charges.usePowerCharges.enabled');

    expect(mappingFlask.severity).toBe('info');
    expect(bossingFlask.severity).toBe('warning');
    expect(mappingCharge.severity).toBe('info');
    expect(bossingCharge.severity).toBe('warning');
  });

  it('accepts only the MVP profiles', async () => {
    expect(CONFIG_ASSUMPTION_PROFILE_VALUES).toEqual(['sc_trade_mapping', 'hc_trade_bossing']);

    const luaClient = makeLuaClient();
    await expect(
      handleAnalyzeConfigAssumptions(makeContext(luaClient), { profile: 'ssf_progression' })
    ).rejects.toThrow(/Unsupported profile/);
  });

  it('returns structured unknowns when config data is unavailable', async () => {
    const luaClient = makeLuaClient({
      methods: {
        getConfig: jest.fn<() => Promise<any>>().mockResolvedValue(null),
      },
    });

    const result = await handleAnalyzeConfigAssumptions(makeContext(luaClient), {
      profile: 'sc_trade_mapping',
    });
    const output = JSON.parse(result.content[0].text);

    expect(output.summary.overall).toBe('unknown');
    expect(output.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'config.unavailable',
          reason: expect.stringContaining('getConfig returned no configuration data'),
        }),
      ])
    );
  });

  it('returns per-field unknowns for partial config data', async () => {
    const luaClient = makeLuaClient({
      methods: {
        getConfig: jest.fn<() => Promise<any>>().mockResolvedValue({
          usePowerCharges: true,
        }),
      },
    });

    const result = await handleAnalyzeConfigAssumptions(makeContext(luaClient), {
      profile: 'hc_trade_bossing',
    });
    const output = JSON.parse(result.content[0].text);

    expect(output.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'charges.usePowerCharges.enabled' }),
      ])
    );
    expect(output.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'charges.useFrenzyCharges.missing' }),
        expect.objectContaining({ id: 'charges.useEnduranceCharges.missing' }),
        expect.objectContaining({ id: 'charges.useSiphoningCharges.missing' }),
      ])
    );
  });

  it('summarizes non-default enemy settings without reporting default enemy level noise', async () => {
    const { output } = await analyze({
      config: {
        usePowerCharges: false,
        useFrenzyCharges: false,
        useEnduranceCharges: false,
        useSiphoningCharges: false,
        enemyLevel: 84,
        enemyArmour: 30000,
        enemyFireResist: 75,
      },
    }, 'hc_trade_bossing');

    expect(output.assumptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'enemy.enemyLevel.set' }),
      ])
    );
    expect(output.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'enemy.configuration.overrides',
          evidence: ['enemyArmour=30000', 'enemyFireResist=75'],
        }),
      ])
    );
  });

  it('classifies Vaal Molten Shell as burst-only Vaal evidence, not a separate guard finding', async () => {
    const { output } = await analyze({
      skills: {
        groups: [
          {
            enabled: true,
            gems: [
              { name: 'Vaal Molten Shell', enabled: true },
            ],
          },
        ],
      },
    }, 'hc_trade_bossing');

    expect(output.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'skills.vaal.enabled',
          evidence: ['Vaal Molten Shell'],
        }),
      ])
    );
    expect(output.assumptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'skills.guard.enabled' }),
      ])
    );
  });

  it('returns unknowns instead of inferring skill uptime when enabled flags are absent', async () => {
    const { output } = await analyze({
      skills: {
        groups: [
          {
            index: 1,
            gems: [
              { index: 1, name: 'Steelskin' },
            ],
          },
          {
            index: 2,
            enabled: true,
            gems: [
              { index: 1, name: 'Molten Shell' },
            ],
          },
        ],
      },
    }, 'hc_trade_bossing');

    expect(output.assumptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'skills.guard.enabled' }),
      ])
    );
    expect(output.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'skills.group.1.enabled_unknown' }),
        expect.objectContaining({ id: 'skills.gem.1.enabled_unknown' }),
      ])
    );
  });

  it('reports an explicit unknown when no flask entries are present', async () => {
    const { output } = await analyze({
      items: [],
    }, 'sc_trade_mapping');

    expect(output.unknowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'flasks.none_detected' }),
      ])
    );
  });

  it('detects guard skills only from enabled exposed skill data', async () => {
    const { output } = await analyze({
      skills: {
        groups: [
          {
            enabled: true,
            gems: [
              { name: 'Steelskin', enabled: true },
              { name: 'Molten Shell', enabled: false },
            ],
          },
          {
            enabled: false,
            gems: [
              { name: 'Immortal Call', enabled: true },
            ],
          },
        ],
      },
    }, 'hc_trade_bossing');

    const guardFinding = output.assumptions.find((item: any) => item.id === 'skills.guard.enabled');
    expect(guardFinding.evidence).toEqual(['Steelskin']);
    expect(guardFinding.classification).toBe('guard_skill_dependent');
  });

  it('does not call mutating methods for any MVP profile', async () => {
    for (const profile of CONFIG_ASSUMPTION_PROFILE_VALUES) {
      const luaClient = makeLuaClient({
        config: {
          usePowerCharges: true,
        },
        items: [
          { id: 1, slot: 'Flask 1', name: 'Diamond Flask', active: true },
        ],
      });

      await handleAnalyzeConfigAssumptions(makeContext(luaClient), { profile });

      expect(luaClient.getConfig).toHaveBeenCalled();
      expect(luaClient.getItems).toHaveBeenCalled();
      expect(luaClient.getSkills).toHaveBeenCalled();
      expect(luaClient.getBuildInfo).toHaveBeenCalled();
      expect(luaClient.setConfig).not.toHaveBeenCalled();
      expect(luaClient.setFlaskActive).not.toHaveBeenCalled();
      expect(luaClient.saveBuild).not.toHaveBeenCalled();
    }
  });
});
