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
});
