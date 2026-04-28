import { describe, expect, it, jest } from '@jest/globals';
import { handleUpdateTreeDelta } from '../../src/handlers/luaHandlers';

function makeContext(luaClient: any) {
  return {
    pobDirectory: '/tmp',
    luaEnabled: true,
    getLuaClient: () => luaClient,
    ensureLuaClient: jest.fn(async () => undefined),
    stopLuaClient: jest.fn(async () => undefined),
  } as any;
}

describe('handleUpdateTreeDelta guardrails', () => {
  it('reports the actual before/after tree diff for explicit stateful mutations', async () => {
    const luaClient = {
      getTree: jest.fn(async () => ({ nodes: [1, 2, 3] })),
      updateTreeDelta: jest.fn(async () => ({ tree: { nodes: [1, 2, 4, 5] } })),
    };

    const result = await handleUpdateTreeDelta(makeContext(luaClient), ['4'], ['3'], true);
    const text = result.content[0].text;

    expect(luaClient.getTree.mock.invocationCallOrder[0])
      .toBeLessThan(luaClient.updateTreeDelta.mock.invocationCallOrder[0]);
    expect(luaClient.updateTreeDelta).toHaveBeenCalledWith({ addNodes: [4], removeNodes: [3] });
    expect(text).toContain('STATEFUL TREE MUTATION');
    expect(text).toContain('apply=true');
    expect(text).toContain('lua_reload_build');
    expect(text).toContain('Requested add_nodes: 4');
    expect(text).toContain('Requested remove_nodes: 3');
    expect(text).toContain('Actual added: 4, 5');
    expect(text).toContain('Actual removed: 3');
    expect(text).toContain('Additional nodes added by import/pathing: 5');
  });

  it('flags requested nodes that PoB import did not apply or remove', async () => {
    const luaClient = {
      getTree: jest.fn(async () => ({ nodes: [1, 2] })),
      updateTreeDelta: jest.fn(async () => ({ tree: { nodes: [1, 2] } })),
    };

    const result = await handleUpdateTreeDelta(makeContext(luaClient), ['9'], ['2']);
    const text = result.content[0].text;

    expect(text).toContain('Requested add_nodes still absent after import: 9');
    expect(text).toContain('Requested remove_nodes still allocated after import: 2');
  });

  it('rejects invalid node ids before mutating the tree', async () => {
    const luaClient = {
      getTree: jest.fn(),
      updateTreeDelta: jest.fn(),
    };

    await expect(handleUpdateTreeDelta(makeContext(luaClient), ['abc'], undefined))
      .rejects.toThrow('add_nodes contains invalid node id: "abc"');

    expect(luaClient.getTree).not.toHaveBeenCalled();
    expect(luaClient.updateTreeDelta).not.toHaveBeenCalled();
  });
});
