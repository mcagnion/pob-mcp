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

function makeContext(build: any): any {
  return {
    buildService: {
      readBuild: jest.fn(async () => build),
    },
    skillGemService: new SkillGemService(),
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
});
