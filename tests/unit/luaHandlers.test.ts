import { describe, expect, it, jest } from '@jest/globals';
import { handleLuaGetStats, handleUpdateTreeDelta, type LuaHandlerContext } from '../../src/handlers/luaHandlers.js';

function makeContext(luaClient: any): LuaHandlerContext {
  return {
    pobDirectory: '/tmp',
    luaEnabled: true,
    ensureLuaClient: async () => {},
    stopLuaClient: async () => {},
    getLuaClient: () => luaClient,
  };
}

describe('handleLuaGetStats', () => {
  it('adds DPS semantics, totem context, and freshness metadata to offense stats', async () => {
    const luaClient = {
      getStats: jest.fn(async () => ({
        TotalDPS: 1000,
        CombinedDPS: 1200,
        FullDPS: 3600,
        ActiveTotemLimit: 3,
        Speed: 2.1,
        _meta: { generation: 12 },
      })),
      getSkills: jest.fn(async () => ({
        mainSocketGroup: 2,
        groups: [
          {
            index: 2,
            label: 'Ballista setup',
            slot: 'Weapon 1',
            includeInFullDPS: true,
            skills: ['Kinetic Fusillade Ballista'],
          },
        ],
      })),
    };

    const result = await handleLuaGetStats(makeContext(luaClient), 'offense');
    const text = result.content[0].text;

    expect(text).toContain('**Metadata:**');
    expect(text).toContain('Source: live Lua bridge get_stats');
    expect(text).toContain('Category: offense');
    expect(text).toContain('Freshness marker: retrievedAt=');
    expect(text).toContain('Main skill group: 2 (Ballista setup) in Weapon 1');
    expect(text).toContain('Groups included in FullDPS: 2:Ballista setup');
    expect(text).toContain('**DPS Context:**');
    expect(text).toContain('TotalDPS: PoB active skill damage metric');
    expect(text).toContain('FullDPS: PoB aggregate across skill groups marked as included in Full DPS');
    expect(text).toContain('Totem context: ActiveTotemLimit=3');
    expect(text).toContain('TotalDPS: 1000');
    expect(text).toContain('FullDPS: 3600');
    expect(text).not.toContain('_meta: [object Object]');
  });
});

describe('handleUpdateTreeDelta', () => {
  it('labels update_tree_delta as stateful only when apply=true', async () => {
    const luaClient = {
      getTree: jest.fn(async () => ({
        nodes: [1, 2],
      })),
      updateTreeDelta: jest.fn(async () => ({
        tree: { nodes: [1, 2, 123] },
      })),
    };

    const result = await handleUpdateTreeDelta(makeContext(luaClient), ['123'], undefined, true);
    const text = result.content[0].text;

    expect(luaClient.updateTreeDelta).toHaveBeenCalledWith({ addNodes: [123] });
    expect(text).toContain('STATEFUL TREE MUTATION');
    expect(text).toContain('apply=true');
    expect(text).toContain('lua_reload_build');
    expect(text).toContain('Tree delta applied');
    expect(text).toContain('Actual added: 123');
  });
});
