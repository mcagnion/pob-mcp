import { describe, expect, it, jest } from '@jest/globals';
import { handleSearchTreeNodes } from '../../src/handlers/luaHandlers.js';

function makeContext(luaClient: any) {
  return {
    pobDirectory: '/tmp',
    luaEnabled: true,
    getLuaClient: () => luaClient,
    ensureLuaClient: jest.fn(async () => undefined),
    stopLuaClient: jest.fn(async () => undefined),
  } as any;
}

describe('handleSearchTreeNodes allocation guardrails', () => {
  it('makes allocated and unallocated passive search hits explicit', async () => {
    const luaClient = {
      searchNodes: jest.fn(async () => ({
        count: 2,
        nodes: [
          {
            id: 101,
            name: "The King's Heritage",
            type: 'notable',
            allocated: true,
            stats: ['Aul Bloodline: Determination'],
          },
          {
            id: 102,
            name: "The King's Heritage",
            type: 'notable',
            allocated: false,
            stats: ['Aul Bloodline: Anger'],
          },
        ],
      })),
    };

    const result = await handleSearchTreeNodes(makeContext(luaClient), "King's Heritage", 'notable', 10, true);
    const text = result.content[0].text;

    expect(luaClient.searchNodes).toHaveBeenCalledWith({
      keyword: "King's Heritage",
      nodeType: 'notable',
      maxResults: 10,
      includeAllocated: true,
    });
    expect(text).toContain('Allocation summary: 1 allocated / 1 unallocated in returned matches');
    expect(text).toContain('[ALLOCATED]');
    expect(text).toContain('[UNALLOCATED]');
    expect(text).toContain('Allocation: ACTIVE in current loaded build');
    expect(text).toContain('Allocation: NOT allocated in current loaded build');
    expect(text).toContain('Passive choice guardrail');
    expect(text).toContain('inspect every sibling option');
  });
});
