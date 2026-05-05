import { describe, it, expect, jest } from '@jest/globals';
import { getConfigToolSchemas } from '../../src/server/toolSchemas';
import { routeToolCall } from '../../src/server/toolRouter';

function makeLuaClient() {
  return {
    getConfig: jest.fn<() => Promise<any>>().mockResolvedValue({
      usePowerCharges: true,
      useFrenzyCharges: false,
      useEnduranceCharges: false,
      useSiphoningCharges: false,
    }),
    getItems: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    getSkills: jest.fn<() => Promise<any>>().mockResolvedValue({ groups: [] }),
    getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ name: 'Routed Build' }),
    setConfig: jest.fn<() => Promise<any>>().mockResolvedValue({}),
    setFlaskActive: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    saveBuild: jest.fn<() => Promise<any>>().mockResolvedValue({}),
  };
}

function makeContextBuilder() {
  return {
    buildHandlerContext: jest.fn(() => ({})),
    buildWatchContext: jest.fn(() => ({})),
    buildTreeContext: jest.fn(() => ({})),
    buildLuaContext: jest.fn(() => ({})),
    buildItemSkillContext: jest.fn(() => ({})),
    buildOptimizationContext: jest.fn(() => ({})),
    buildExportContext: jest.fn(() => ({})),
    buildSkillGemContext: jest.fn(() => ({})),
  };
}

describe('analyze_config_assumptions tool wiring', () => {
  it('registers the tool schema with MVP profile values', () => {
    const schema = getConfigToolSchemas().find(tool => tool.name === 'analyze_config_assumptions');

    expect(schema).toBeDefined();
    expect(schema.description).toContain('without mutating the build');
    expect(schema.inputSchema.properties.profile.enum).toEqual([
      'sc_trade_mapping',
      'hc_trade_bossing',
    ]);
  });

  it('routes tool calls to the read-only handler', async () => {
    const luaClient = makeLuaClient();
    const result = await routeToolCall(
      'analyze_config_assumptions',
      { profile: 'hc_trade_bossing' },
      {
        toolGate: { checkGate: jest.fn() },
        contextBuilder: makeContextBuilder(),
        tradeClient: null,
        statMapper: null,
        recommendationEngine: null,
        ninjaClient: {},
        getLuaClient: () => luaClient,
        ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      } as any
    );

    const output = JSON.parse(result.content[0].text);
    expect(output.profile).toBe('hc_trade_bossing');
    expect(output.assumptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'charges.usePowerCharges.enabled' }),
      ])
    );
    expect(luaClient.setConfig).not.toHaveBeenCalled();
    expect(luaClient.setFlaskActive).not.toHaveBeenCalled();
    expect(luaClient.saveBuild).not.toHaveBeenCalled();
  });
});
