import { describe, expect, it, jest } from '@jest/globals';
import {
  handleGemUpgradePath,
  handleSuggestSupportGems,
  handleValidateGemQuality,
} from '../../src/handlers/skillGemHandlers.js';
import { SkillGemService } from '../../src/services/skillGemService.js';

function makeMinionBuild(): any {
  return {
    Skills: {
      SkillSet: {
        Skill: {
          Gem: [
            { nameSpec: 'Summon Skeletons', level: 20, quality: 20 },
            { nameSpec: 'Spell Echo Support', level: 20, quality: 0 },
          ],
        },
      },
    },
  };
}

function makeContext(build = makeMinionBuild()): any {
  return {
    buildService: {
      readBuild: jest.fn(async () => build),
    },
    skillGemService: new SkillGemService(),
  };
}

describe('gem feasibility guardrails', () => {
  it('labels support recommendations with measurement, acquisition, and price gates', async () => {
    const result = await handleSuggestSupportGems(makeContext(), {
      build_name: 'test.xml',
      count: 2,
      budget: 'endgame',
    });
    const text = result.content[0].text;

    expect(text).toContain('Verification gates: DPS is heuristic unless marked measured');
    expect(text).toContain('Measured: heuristic estimate only (not live PoB DPS)');
    expect(text).toContain('Acquirable: unverified in requested league');
    expect(text).toContain('Price-checked: no');
    expect(text).toContain('Price: not price-checked');
    expect(text).toContain('PoB calc support does not prove current-league acquisition');
  });

  it('states gem corruption caps and does not imply +2 gem levels', async () => {
    const result = await handleValidateGemQuality(makeContext(), {
      build_name: 'test.xml',
      include_corrupted: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('Summon Skeletons (current) → 21/23 (corrupted)');
    expect(text).toContain('Corruption can add at most +1 gem level and +3% quality');
    expect(text).not.toContain('22/');
    expect(text).not.toContain('+2 gem level');
  });

  it('marks Exceptional upgrade path entries as unverified and not price-checked', async () => {
    const luaClient = {
      getSkills: jest.fn(async () => ({
        mainSocketGroup: 1,
        groups: [{
          index: 1,
          label: 'Main Skill',
          gems: [
            { name: 'Summon Skeletons', level: 20, quality: 20, isSupport: false },
            { name: 'Minion Damage Support', level: 18, quality: 20, isSupport: true },
          ],
        }],
      })),
    };
    const context = {
      ...makeContext(),
      ensureLuaClient: jest.fn(async () => undefined),
      getLuaClient: () => luaClient,
    };

    const result = await handleGemUpgradePath(context, {
      build_name: 'test.xml',
      budget: 'endgame',
    });
    const text = result.content[0].text;

    expect(text).toContain('Check Exceptional Minion Damage Support');
    expect(text).toContain('Acquirable: unverified in requested league');
    expect(text).toContain('Price-checked: no');
    expect(text).toContain('not price-checked; verify current league trade availability before buying');
    expect(text).toContain('PoB calc support is not proof of acquisition');
  });
});
