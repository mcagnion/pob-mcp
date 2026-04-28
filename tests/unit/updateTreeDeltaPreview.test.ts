import { describe, expect, it, jest } from '@jest/globals';
import { handleUpdateTreeDelta, type LuaHandlerContext } from '../../src/handlers/luaHandlers.js';

function makeContext(updateTreeDelta: jest.Mock): LuaHandlerContext {
  return {
    pobDirectory: '/tmp',
    luaEnabled: true,
    ensureLuaClient: jest.fn(async () => undefined),
    getLuaClient: () => ({
      updateTreeDelta,
    } as any),
    stopLuaClient: jest.fn(async () => undefined),
  };
}

describe('handleUpdateTreeDelta preview mode', () => {
  it('requests restore-after preview by default and reports restored state', async () => {
    const updateTreeDelta = jest.fn(async () => ({
      tree: { nodes: [1, 2, 3] },
      restored: true,
      restoredTree: { nodes: [1, 2] },
    }));
    const context = makeContext(updateTreeDelta);

    const result = await handleUpdateTreeDelta(context, ['3']);
    const text = result.content[0].text;

    expect(updateTreeDelta).toHaveBeenCalledWith({ addNodes: [3], restoreAfter: true });
    expect(text).toContain('Tree delta previewed');
    expect(text).toContain('Restored allocation: 2 nodes');
  });

  it('keeps the mutation only when apply is true', async () => {
    const updateTreeDelta = jest.fn(async () => ({
      tree: { nodes: [1, 2, 3] },
      restored: false,
    }));
    const context = makeContext(updateTreeDelta);

    const result = await handleUpdateTreeDelta(context, ['3'], undefined, true);
    const text = result.content[0].text;

    expect(updateTreeDelta).toHaveBeenCalledWith({ addNodes: [3] });
    expect(text).toContain('Tree delta applied');
    expect(text).not.toContain('restore-after preview');
  });
});
