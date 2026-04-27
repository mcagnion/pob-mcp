import { describe, expect, it, jest } from '@jest/globals';
import { handleSuggestOptimalNodes, type OptimizationHandlerContext } from '../../src/handlers/optimizationHandlers.js';

function makeContext(luaClient: any): OptimizationHandlerContext {
  return {
    buildService: {} as any,
    treeService: {} as any,
    pobDirectory: '/tmp',
    ensureLuaClient: async () => {},
    getLuaClient: () => luaClient,
  };
}

describe('handleSuggestOptimalNodes', () => {
  it('ranks life goal recommendations by calcWith Life delta', async () => {
    const luaClient = {
      getSkills: jest.fn(async () => ({ socketGroups: [] })),
      searchNodes: jest.fn(async ({ keyword }: { keyword: string }) => {
        if (keyword === 'life') {
          return {
            nodes: [
              {
                id: 101,
                name: 'Life Regeneration Trap',
                type: 'notable',
                stats: ['1% of Life Regenerated per second'],
              },
              {
                id: 202,
                name: 'Revenge of the Hunted',
                type: 'notable',
                stats: ['10% increased maximum Life'],
              },
            ],
          };
        }

        return { nodes: [] };
      }),
      getStats: jest.fn(async () => ({ Life: 1000 })),
      calcWith: jest.fn(async ({ addNodes }: { addNodes: number[] }) => {
        const [nodeId] = addNodes;
        return {
          101: { Life: 1000 },
          202: { Life: 1150 },
        }[nodeId];
      }),
    };

    const result = await handleSuggestOptimalNodes(makeContext(luaClient), '', 'life', 3);
    const text = result.content[0].text;

    expect(text).toContain('ranked by calcWith Life delta');
    expect(text).toContain('**Revenge of the Hunted** [Notable]');
    expect(text).toContain('Life Δ: +150 (to 1,150)');
    expect(text).not.toContain('**Life Regeneration Trap**');
    expect(luaClient.calcWith).toHaveBeenCalledWith({ addNodes: [101] });
    expect(luaClient.calcWith).toHaveBeenCalledWith({ addNodes: [202] });
  });
});
