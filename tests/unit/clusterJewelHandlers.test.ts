import { describe, expect, it } from '@jest/globals';
import { handleAnalyzeBuildClusterJewels } from '../../src/handlers/clusterJewelHandlers.js';

function makeContext(items: any[], skills: any = { groups: [] }) {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () => ({
      getItems: async () => items,
      getSkills: async () => skills,
    } as any),
  };
}

describe('handleAnalyzeBuildClusterJewels', () => {
  it('detects tree-socketed cluster jewels from Lua baseName output', async () => {
    const context = makeContext([
      {
        slot: 'Jewel 7960',
        name: 'Ghoul Vessel',
        baseName: 'Large Cluster Jewel',
        raw: [
          'Rarity: Rare',
          'Ghoul Vessel',
          'Large Cluster Jewel',
          'Adds 8 Passive Skills',
          '1 Added Passive Skill is Martial Prowess',
          '1 Added Passive Skill is Storm\'s Hand',
        ].join('\n'),
      },
    ]);

    const result = await handleAnalyzeBuildClusterJewels(context);
    const text = result.content[0].text;

    expect(text).toContain('Scan scope: 1 cluster jewel(s) found in 1 active item slots');
    expect(text).toContain('### Ghoul Vessel (Jewel 7960)');
    expect(text).toContain('Base: Large Cluster Jewel');
    expect(text).toContain('Martial Prowess');
    expect(text).not.toContain('No cluster jewels detected');
  });

  it('parses unclassified cluster notables from added passive skill lines', async () => {
    const context = makeContext([
      {
        slot: 'Jewel 29712',
        name: 'Sol Hope',
        base: 'Medium Cluster Jewel',
        raw: [
          'Rarity: Rare',
          'Sol Hope',
          'Medium Cluster Jewel',
          'Adds 5 Passive Skills',
          '1 Added Passive Skill is a Jewel Socket',
          'Added Small Passive Skills grant: 12% increased Totem Damage',
          '1 Added Passive Skill is Sleepless Sentries',
          '1 Added Passive Skill is Snaring Spirits',
        ].join('\n'),
      },
    ]);

    const result = await handleAnalyzeBuildClusterJewels(context);
    const text = result.content[0].text;

    expect(text).toContain('Sleepless Sentries [unclassified]');
    expect(text).toContain('Snaring Spirits [unclassified]');
    expect(text).not.toContain('a Jewel Socket [unclassified]');
    expect(text).not.toContain('Could not parse notables');
  });
});
