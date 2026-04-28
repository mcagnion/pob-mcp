import { describe, it, expect, jest } from '@jest/globals';
import { handleSetGemQuality } from '../../src/handlers/itemSkillHandlers';

function createContext(options: {
  beforeStats?: Record<string, any>;
  afterStats?: Record<string, any>;
  gemQuality?: number;
}) {
  const luaClient = {
    getStats: jest
      .fn<() => Promise<Record<string, any>>>()
      .mockResolvedValueOnce(options.beforeStats ?? {})
      .mockResolvedValueOnce(options.afterStats ?? {}),
    setGemQuality: jest.fn(async () => undefined),
    getSkills: jest.fn(async () => ({
      groups: [
        {
          index: 2,
          gems: [
            {
              name: 'Kinetic Fusillade',
              quality: options.gemQuality,
              qualityId: 'Default',
            },
          ],
        },
      ],
    })),
  };

  return {
    context: {
      ensureLuaClient: jest.fn(async () => undefined),
      getLuaClient: () => luaClient as any,
    },
    luaClient,
  };
}

describe('handleSetGemQuality', () => {
  it('returns post-mutation gem readback and stat deltas', async () => {
    const { context, luaClient } = createContext({
      beforeStats: { FullDPS: 1000, TotalDPS: 400, ManaCost: 21 },
      afterStats: { FullDPS: 1200, TotalDPS: 450, ManaCost: 21 },
      gemQuality: 20,
    });

    const result = await handleSetGemQuality(context, 2, 1, 20);
    const text = result.content[0].text;

    expect(luaClient.getStats).toHaveBeenCalledTimes(2);
    expect(luaClient.getStats).toHaveBeenCalledWith([
      'FullDPS',
      'FullDotDPS',
      'TotalDPS',
      'CombinedDPS',
      'TotalDotDPS',
      'Speed',
      'ManaCost',
    ]);
    expect(luaClient.setGemQuality).toHaveBeenCalledWith({
      groupIndex: 2,
      gemIndex: 1,
      quality: 20,
      qualityId: undefined,
    });
    expect(text).toContain('Post-mutation verification');
    expect(text).toContain('Gem readback: Kinetic Fusillade Q20');
    expect(text).toContain('target Q20 confirmed');
    expect(text).toContain('FullDPS: 1,000 -> 1,200 (+200)');
    expect(text).toContain('TotalDPS: 400 -> 450 (+50)');
    expect(text).toContain('Freshness marker: retrievedAt=');
  });

  it('warns when tracked stats do not change after readback', async () => {
    const { context } = createContext({
      beforeStats: { FullDPS: 1000, TotalDPS: 400 },
      afterStats: { FullDPS: 1000, TotalDPS: 400 },
      gemQuality: 10,
    });

    const result = await handleSetGemQuality(context, 2, 1, 10);
    const text = result.content[0].text;

    expect(text).toContain('target Q10 confirmed');
    expect(text).toContain('no tracked stat changed');
    expect(text).toContain('verify the active skill before ranking quality upgrades');
  });

  it('rejects quality above the modeled gem corruption cap', async () => {
    const { context, luaClient } = createContext({});

    await expect(handleSetGemQuality(context, 2, 1, 24)).rejects.toThrow(
      'Failed to set gem quality: quality must be between 0 and 23'
    );
    expect(luaClient.setGemQuality).not.toHaveBeenCalled();
  });
});
