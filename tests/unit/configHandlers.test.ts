import { describe, it, expect } from '@jest/globals';
import {
  handleSetConfig,
  handleSetEnemyStats,
  type ConfigHandlerContext,
} from '../../src/handlers/configHandlers.js';

function makeContext(overrides: Partial<{
  setConfigResult: {
    config: any;
    appliedKeys: string[];
    aliasedKeys: Record<string, string>;
    ignoredKeys: string[];
  };
  config: Record<string, any>;
  stats: Record<string, number>;
}> = {}): ConfigHandlerContext {
  const luaClient = {
    getConfig: jest.fn().mockResolvedValue(overrides.config || {}),
    setConfig: jest.fn().mockResolvedValue(overrides.setConfigResult || {
      config: {}, appliedKeys: [], aliasedKeys: {}, ignoredKeys: [],
    }),
    getStats: jest.fn().mockResolvedValue(overrides.stats || { TotalDPS: 1000, Life: 5000 }),
  } as any;
  return {
    getLuaClient: () => luaClient,
    ensureLuaClient: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('handleSetConfig', () => {
  it('throws when the requested key is reported as ignored by the bridge', async () => {
    const context = makeContext({
      setConfigResult: {
        config: {}, appliedKeys: [], aliasedKeys: {},
        ignoredKeys: ['conditionEnemyBurning'],
      },
    });
    await expect(
      handleSetConfig(context, { config_name: 'conditionEnemyBurning', value: true })
    ).rejects.toThrow(/conditionEnemyBurning.*not a known PoB config var/);
  });

  it('renders alias info when the bridge reports the key was renamed', async () => {
    const context = makeContext({
      setConfigResult: {
        config: {},
        appliedKeys: ['enemyFireResist'],
        aliasedKeys: { enemyFireResistance: 'enemyFireResist' },
        ignoredKeys: [],
      },
    });
    const result = await handleSetConfig(context, {
      config_name: 'enemyFireResistance',
      value: 75,
    });
    expect(result.content[0].text).toContain('enemyFireResist');
    expect(result.content[0].text).toContain('alias');
  });

  it('reports a normal update when the key is applied as-is', async () => {
    const context = makeContext({
      setConfigResult: {
        config: {},
        appliedKeys: ['conditionFortify'],
        aliasedKeys: {},
        ignoredKeys: [],
      },
    });
    const result = await handleSetConfig(context, {
      config_name: 'conditionFortify',
      value: true,
    });
    expect(result.content[0].text).toContain('Configuration Updated');
    expect(result.content[0].text).toContain('conditionFortify');
    expect(result.content[0].text).not.toContain('alias');
  });
});

describe('handleSetEnemyStats', () => {
  it('warns about ignored keys in the rendered output', async () => {
    const context = makeContext({
      setConfigResult: {
        config: {},
        appliedKeys: ['enemyFireResist'],
        aliasedKeys: {},
        ignoredKeys: ['enemyArmor'],
      },
    });
    const result = await handleSetEnemyStats(context, {
      fire_resist: 75,
      armor: 20000,
    });
    expect(result.content[0].text).toContain('Ignored');
    expect(result.content[0].text).toContain('enemyArmor');
  });

  it('omits the warning when nothing is ignored', async () => {
    const context = makeContext({
      setConfigResult: {
        config: {},
        appliedKeys: ['enemyFireResist'],
        aliasedKeys: {},
        ignoredKeys: [],
      },
    });
    const result = await handleSetEnemyStats(context, { fire_resist: 75 });
    expect(result.content[0].text).not.toContain('Ignored');
  });
});
