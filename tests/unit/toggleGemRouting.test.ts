import { describe, expect, it, jest } from '@jest/globals';
import { routeToolCall } from '../../src/server/toolRouter.js';

function makeDeps(luaClient: any): any {
  const itemSkillContext = {
    ensureLuaClient: jest.fn(async () => undefined),
    getLuaClient: jest.fn(() => luaClient),
  };

  return {
    toolGate: { checkGate: jest.fn() },
    contextBuilder: {
      buildHandlerContext: jest.fn(() => ({})),
      buildWatchContext: jest.fn(() => ({})),
      buildTreeContext: jest.fn(() => ({})),
      buildLuaContext: jest.fn(() => ({})),
      buildItemSkillContext: jest.fn(() => itemSkillContext),
      buildOptimizationContext: jest.fn(() => ({})),
      buildExportContext: jest.fn(() => ({})),
      buildSkillGemContext: jest.fn(() => ({})),
    },
    tradeClient: null,
    statMapper: null,
    recommendationEngine: null,
    ninjaClient: {},
    getLuaClient: jest.fn(() => luaClient),
    ensureLuaClient: jest.fn(async () => undefined),
  };
}

describe('toggle_gem routing', () => {
  it('routes through the Lua set_gem_enabled client call', async () => {
    const luaClient = {
      setGemEnabled: jest.fn(async () => undefined),
    };

    const result = await routeToolCall(
      'toggle_gem',
      { group_index: 1, gem_index: 2, enabled: false },
      makeDeps(luaClient)
    );

    expect(luaClient.setGemEnabled).toHaveBeenCalledWith({
      groupIndex: 1,
      gemIndex: 2,
      enabled: false,
    });
    expect(result.content[0].text).toContain('Gem 2 in group 1 disabled');
  });
});
