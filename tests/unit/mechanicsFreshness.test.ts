import { describe, expect, it, jest } from '@jest/globals';
import { handleFindItemUpgrades } from '../../src/handlers/itemShoppingHandler';
import { handleGemUpgradePath } from '../../src/handlers/skillGemHandlers';

describe('mechanics freshness guardrails', () => {
  it('does not present stale helmet enchants as current shopping advice', async () => {
    const result = await handleFindItemUpgrades(
      { getLuaClient: () => null },
      { slot: 'Helmet' }
    );
    const text = result.content[0].text;

    expect(text).toContain('Mechanics Freshness');
    expect(text).toContain('verify current implicit/mod availability');
    expect(text).not.toContain('40% increased minion damage enchant');
    expect(text).not.toContain('massive damage boost');
  });

  it('does not recommend Hillock quality as a static gem upgrade mechanic', async () => {
    const luaClient = {
      getSkills: jest.fn().mockResolvedValue({
        mainSocketGroup: 1,
        groups: [
          {
            index: 1,
            label: 'Main Skill',
            gems: [{ name: 'Fireball', level: 20, quality: 0 }],
          },
        ],
      } as never),
    };

    const context = {
      buildService: {} as any,
      skillGemService: {} as any,
      ensureLuaClient: jest.fn(async () => undefined),
      getLuaClient: () => luaClient as any,
    } as any;

    const result = await handleGemUpgradePath(context, { budget: 'endgame' });
    const text = result.content[0].text;

    expect(text).toContain('Mechanics freshness');
    expect(text).toContain('post-change stat readback');
    expect(text).not.toContain('Hillock');
    expect(text).not.toContain('+28% quality');
  });
});
