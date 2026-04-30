import { describe, expect, it, jest } from '@jest/globals';
import { handleValidateGemQuality } from '../../src/handlers/skillGemHandlers.js';
import { SkillGemService } from '../../src/services/skillGemService.js';

function makeBuildWithDuplicateGemNames(): any {
  return {
    Skills: {
      SkillSet: {
        Skill: [
          {
            slot: 'Body Armour',
            Gem: [
              { nameSpec: 'Kinetic Fusillade', level: 20, quality: 20 },
              { nameSpec: 'Greater Volley Support', level: 20, quality: 23 },
            ],
          },
          {
            slot: 'Helmet',
            Gem: [
              { nameSpec: 'Power Siphon', level: 20, quality: 20 },
              { nameSpec: 'Greater Volley Support', level: 20, quality: 0 },
            ],
          },
        ],
      },
    },
  };
}

function makeContext(build: any, luaClient?: any): any {
  return {
    buildService: {
      readBuild: jest.fn(async () => build),
    },
    skillGemService: new SkillGemService(),
    getLuaClient: luaClient ? jest.fn(() => luaClient) : undefined,
  };
}

describe('gem quality validation', () => {
  it('disambiguates duplicate gem names by slot, group, and gem index', () => {
    const validation = new SkillGemService().validateGemQuality(makeBuildWithDuplicateGemNames());

    expect(validation.needsQuality).toHaveLength(1);
    expect(validation.needsQuality[0]).toMatchObject({
      gem: 'Greater Volley Support',
      current: '20/0',
      recommended: '20/20',
      impact: 'Unmeasured',
      measured: false,
      qualityGap: 20,
      location: {
        slot: 'Helmet',
        groupIndex: 2,
        skillIndex: 1,
        gemIndex: 2,
        activeSkillName: 'Power Siphon',
      },
    });

    expect(validation.qualityCapped).toHaveLength(1);
    expect(validation.qualityCapped[0]).toMatchObject({
      gem: 'Greater Volley Support',
      current: '20/23',
      location: {
        slot: 'Body Armour',
        groupIndex: 1,
        skillIndex: 0,
        gemIndex: 2,
        activeSkillName: 'Kinetic Fusillade',
      },
    });
  });

  it('renders quality gaps as unmeasured and not as DPS impact labels', async () => {
    const result = await handleValidateGemQuality(makeContext(makeBuildWithDuplicateGemNames()), {
      build_name: 'synthetic.xml',
    });
    const text = result.content[0].text;

    expect(text).toContain('Greater Volley Support');
    expect(text).toContain('Location: slot=Helmet, group_index=2, skill_index=1, gem_index=2, active_skill=Power Siphon');
    expect(text).toContain('Measured: no - not measured against this build');
    expect(text).toContain('not a DPS ranking');
    expect(text).toContain('Quality-capped gem copies');
    expect(text).toContain('Location: slot=Body Armour, group_index=1, skill_index=0, gem_index=2, active_skill=Kinetic Fusillade');
    expect(text).not.toContain('Impact: High');
    expect(text).not.toContain('Impact: Medium');
    expect(text).not.toContain('highest impact');
  });

  it('renders measured quality preview deltas when the requested build is loaded', async () => {
    const previewGemQuality = jest.fn(async () => ({
      before: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      after: { FullDPS: 1120, TotalDPS: 500, Speed: 2.1 },
      restoredStats: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      restored: true,
      gemBefore: { name: 'Greater Volley Support', quality: 0, qualityId: 'Default' },
      gemPreview: { name: 'Greater Volley Support', quality: 20, qualityId: 'Default' },
      gemRestored: { name: 'Greater Volley Support', quality: 0, qualityId: 'Default' },
    }));
    const luaClient = {
      isAlive: jest.fn(() => true),
      getBuildInfo: jest.fn(async () => ({ name: 'synthetic' })),
      previewGemQuality,
    };

    const result = await handleValidateGemQuality(makeContext(makeBuildWithDuplicateGemNames(), luaClient), {
      build_name: 'synthetic.xml',
    });
    const text = result.content[0].text;

    expect(previewGemQuality).toHaveBeenCalledWith({
      groupIndex: 2,
      gemIndex: 2,
      quality: 20,
      fields: expect.arrayContaining(['FullDPS', 'TotalDPS', 'Speed']),
    });
    expect(text).toContain('Live measurement: non-destructive gem-quality preview');
    expect(text).toContain('Measured: yes - previewed Q20; restored=yes');
    expect(text).toContain('FullDPS: 1,000 -> 1,120 (+120, +12%)');
    expect(text).toContain('Speed: 2 -> 2.1 (+0.1, +5%)');
    expect(text).toContain('Priority: Greater Volley Support has the highest measured DPS-field delta (+120');
    expect(text).not.toContain('not a DPS ranking');
    expect(text).not.toContain('highest impact');
  });

  it('keeps zero modeled quality deltas separate from QoL or untracked effects', async () => {
    const previewGemQuality = jest.fn(async () => ({
      before: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      after: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      restoredStats: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      restored: true,
    }));
    const luaClient = {
      isAlive: jest.fn(() => true),
      getBuildInfo: jest.fn(async () => ({ name: 'synthetic' })),
      previewGemQuality,
    };

    const result = await handleValidateGemQuality(makeContext(makeBuildWithDuplicateGemNames(), luaClient), {
      build_name: 'synthetic.xml',
    });
    const text = result.content[0].text;

    expect(text).toContain('Measured: yes - previewed Q20; restored=yes');
    expect(text).toContain('Modeled stat delta: none across tracked fields');
    expect(text).toContain('Priority basis: zero modeled delta; only consider QoL or untracked effects');
    expect(text).toContain('highest measured DPS-field delta (0');
  });
});
