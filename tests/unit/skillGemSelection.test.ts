import { describe, expect, it, jest } from '@jest/globals';
import {
  handleAnalyzeSkillLinks,
  handleSuggestSupportGems,
} from '../../src/handlers/skillGemHandlers.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { getSkillGemToolSchemas } from '../../src/server/toolSchemas.js';

function makeBuildWithMainSecond(): any {
  return {
    Skills: {
      activeSkillSet: '1',
      SkillSet: {
        id: '1',
        Skill: [
          {
            enabled: 'true',
            slot: 'Boots',
            Gem: [
              { nameSpec: 'Shield Charge', level: 20, quality: 20 },
              { nameSpec: 'Faster Attacks Support', level: 20, quality: 20 },
            ],
          },
          {
            enabled: 'true',
            slot: 'Body Armour',
            mainActiveSkill: '1',
            Gem: [
              { nameSpec: 'Summon Skeletons', level: 20, quality: 20 },
              { nameSpec: 'Spell Echo Support', level: 20, quality: 20 },
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

function skillGemSchema(name: string): any {
  const schema = getSkillGemToolSchemas().find((tool) => tool.name === name);
  if (!schema) throw new Error(`Missing schema: ${name}`);
  return schema;
}

describe('skill gem selection', () => {
  it('defaults omitted skill_index to the XML mainActiveSkill group', async () => {
    const result = await handleSuggestSupportGems(makeContext(makeBuildWithMainSecond()), {
      build_name: 'test.xml',
    });
    const text = result.content[0].text;

    expect(text).toContain('Support Gem Recommendations for Summon Skeletons');
    expect(text).toContain('Selected Skill: Summon Skeletons (index 1; defaulted to XML mainActiveSkill group)');
    expect(text).not.toContain('Support Gem Recommendations for Shield Charge');
  });

  it('keeps explicit skill_index as a zero-based selector', async () => {
    const result = await handleSuggestSupportGems(makeContext(makeBuildWithMainSecond()), {
      build_name: 'test.xml',
      skill_index: 0,
    });
    const text = result.content[0].text;

    expect(text).toContain('Support Gem Recommendations for Shield Charge');
    expect(text).toContain('Selected Skill: Shield Charge (index 0; explicit zero-based skill_index)');
  });

  it('can select a skill by active gem name and supports PoB XML name attributes', async () => {
    const build = {
      Skills: {
        SkillSet: {
          Skill: [
            { Gem: [{ name: 'Shield Charge' }] },
            { Gem: [{ name: 'Summon Skeletons' }, { name: 'Spell Echo Support' }] },
          ],
        },
      },
    };

    const result = await handleAnalyzeSkillLinks(makeContext(build), {
      build_name: 'test.xml',
      skill_name: 'Summon Skeletons',
    });
    const text = result.content[0].text;

    expect(text).toContain('=== Skill Analysis: Summon Skeletons ===');
    expect(text).toContain('Selected Skill: Summon Skeletons (index 1; matched skill_name="Summon Skeletons")');
  });

  it('documents skill_index as zero-based and exposes skill_name', () => {
    const schema = skillGemSchema('suggest_support_gems');

    expect(schema.inputSchema.properties.skill_index.description).toContain('Zero-based skill group index');
    expect(schema.inputSchema.properties.skill_index.description).not.toContain('0 = main skill');
    expect(schema.inputSchema.properties.skill_name.description).toContain('Exact active skill gem name');
  });
});
