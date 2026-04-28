import { describe, it, expect, jest } from '@jest/globals';
import { handleSuggestMasteries } from '../../src/handlers/treeHandlers';

describe('handleSuggestMasteries', () => {
  it('uses the selected mastery effect as baseline only', async () => {
    const calcWith = jest.fn(async (params: any) => {
      expect(params.masteryEffects).toEqual({ 101: 202 });
      return { CombinedDPS: 1100, TotalEHP: 5200, Life: 4000 };
    });
    const luaClient = {
      getMasteryOptions: jest.fn(async () => ({
        masteries: [{
          nodeId: 101,
          nodeName: 'Life Mastery',
          allocatedEffect: 201,
          availableEffects: [
            { effectId: 201, stat: 'Current effect' },
            { effectId: 202, stat: 'Alternative effect' },
          ],
        }],
      })),
      getStats: jest.fn(async () => ({ CombinedDPS: 1000, TotalEHP: 5000, Life: 4000 })),
      calcWith,
    };

    const result = await handleSuggestMasteries({
      ensureLuaClient: jest.fn(async () => undefined),
      getLuaClient: () => luaClient as any,
    });
    const text = (result.content[0] as any).text;

    expect(text).toContain('Current: Current effect');
    expect(text).toContain('- Alternative effect | DPS Delta+100 | EHP Delta+200');
    expect(text).not.toContain('- Current effect');
    expect(calcWith).toHaveBeenCalledTimes(1);
  });

  it('does not run simulations when a mastery has no alternative effects', async () => {
    const calcWith = jest.fn();
    const luaClient = {
      getMasteryOptions: jest.fn(async () => ({
        masteries: [{
          nodeId: 101,
          nodeName: 'Life Mastery',
          allocatedEffect: 201,
          availableEffects: [{ effectId: 201, stat: 'Current effect' }],
        }],
      })),
      getStats: jest.fn(async () => ({ CombinedDPS: 1000, TotalEHP: 5000, Life: 4000 })),
      calcWith,
    };

    const result = await handleSuggestMasteries({
      ensureLuaClient: jest.fn(async () => undefined),
      getLuaClient: () => luaClient as any,
    });
    const text = (result.content[0] as any).text;

    expect(text).toContain('Current: Current effect');
    expect(text).toContain('(no alternative effects available for this mastery)');
    expect(text).not.toContain('- Current effect');
    expect(calcWith).not.toHaveBeenCalled();
  });
});
