import { describe, expect, it, jest } from '@jest/globals';
import {
  handleMeasureGemContribution,
  handleMeasureLinkContributions,
  handleSuggestSupportGems,
} from '../../src/handlers/skillGemHandlers.js';
import { handleOptimizeSkillLinks } from '../../src/handlers/advancedOptimizationHandlers.js';

const CONTRIBUTION_WARNING =
  'Measured contribution is marginal at the current configuration; values are not additive across multiple gem changes.';
const LINK_GUARDRAIL =
  'Guardrail: before replacing supports, run measure_link_contributions on the loaded build; estimates here are structural and not a measured DPS ranking.';

function makeSkills(gems: any[] = [
  { index: 1, name: 'Kinetic Fusillade', level: 20, quality: 20, enabled: true, isSupport: false },
  { index: 2, name: 'Greater Volley Support', level: 20, quality: 20, enabled: true, isSupport: true },
]) {
  return {
    mainSocketGroup: 1,
    groups: [
      {
        index: 1,
        label: 'Main 6L',
        slot: 'Body Armour',
        enabled: true,
        includeInFullDPS: true,
        gems,
      },
    ],
  };
}

function makeContext(luaClient: any): any {
  return {
    buildService: {
      readBuild: jest.fn(),
    },
    skillGemService: {},
    getLuaClient: jest.fn(() => luaClient),
  };
}

function makeLuaClient(overrides: Record<string, any> = {}): any {
  return {
    isAlive: jest.fn(() => true),
    getBuildInfo: jest.fn(async () => ({ name: 'synthetic' })),
    getSkills: jest.fn(async () => makeSkills()),
    previewGemEnabled: jest.fn(async () => ({
      before: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      after: { FullDPS: 700, TotalDPS: 350, Speed: 2 },
      restoredStats: { FullDPS: 1000, TotalDPS: 500, Speed: 2 },
      restored: true,
    })),
    ...overrides,
  };
}

describe('gem contribution measurement', () => {
  it('formats a single measured gem contribution with before/after stats', async () => {
    const luaClient = makeLuaClient();
    const result = await handleMeasureGemContribution(makeContext(luaClient), {
      build_name: 'synthetic.xml',
      group_index: 1,
      gem_index: 2,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).toHaveBeenCalledWith({
      groupIndex: 1,
      gemIndex: 2,
      enabled: false,
      fields: expect.arrayContaining(['FullDPS', 'TotalDPS', 'Speed']),
    });
    expect(text).toContain('Greater Volley Support');
    expect(text).toContain('Location: group_index=1, gem_index=2');
    expect(text).toContain('Restored: yes');
    expect(text).toContain('FullDPS: 1,000 -> 700 (-300, -30%)');
    expect(text).toContain('current_contribution: 300 FullDPS (30% of current)');
    expect(text).toContain(CONTRIBUTION_WARNING);
  });

  it('reports already-disabled gems without previewing them', async () => {
    const luaClient = makeLuaClient({
      getSkills: jest.fn(async () => makeSkills([
        { index: 1, name: 'Kinetic Fusillade', enabled: true, isSupport: false },
        { index: 2, name: 'Greater Volley Support', enabled: false, isSupport: true },
      ])),
    });

    const result = await handleMeasureGemContribution(makeContext(luaClient), {
      group_index: 1,
      gem_index: 2,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).not.toHaveBeenCalled();
    expect(text).toContain('current_contribution: 0 (gem already disabled in this configuration)');
  });

  it('sorts link contributions by measured primary DPS loss and previews sequentially', async () => {
    const sequence: string[] = [];
    const luaClient = makeLuaClient({
      getSkills: jest.fn(async () => makeSkills([
        { index: 1, name: 'Support A', enabled: true, isSupport: true },
        { index: 2, name: 'Support B', enabled: true, isSupport: true },
      ])),
      previewGemEnabled: jest.fn(async ({ gemIndex }: { gemIndex: number }) => {
        sequence.push(`start${gemIndex}`);
        await Promise.resolve();
        sequence.push(`end${gemIndex}`);
        return gemIndex === 1
          ? { before: { FullDPS: 1000 }, after: { FullDPS: 900 }, restored: true }
          : { before: { FullDPS: 1000 }, after: { FullDPS: 750 }, restored: true };
      }),
    });

    const result = await handleMeasureLinkContributions(makeContext(luaClient), {
      group_index: 1,
    });
    const text = result.content[0].text;

    expect(sequence).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(text.indexOf('Support B')).toBeLessThan(text.indexOf('Support A'));
    expect(text).toContain('Measured current contributions, sorted by primary DPS-field loss');
  });

  it('does not rank when requested build differs from the loaded Lua build', async () => {
    const luaClient = makeLuaClient({
      getBuildInfo: jest.fn(async () => ({ name: 'other-build' })),
    });

    const result = await handleMeasureLinkContributions(makeContext(luaClient), {
      build_name: 'synthetic.xml',
      group_index: 1,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).not.toHaveBeenCalled();
    expect(text).toContain('Measurement unavailable');
    expect(text).toContain('No ranking produced');
  });

  it('keeps failed previews out of the ranked measurements', async () => {
    const luaClient = makeLuaClient({
      previewGemEnabled: jest.fn(async () => {
        throw new Error('preview failed; restored=true');
      }),
    });

    const result = await handleMeasureLinkContributions(makeContext(luaClient), {
      group_index: 1,
    });
    const text = result.content[0].text;

    expect(text).toContain('No enabled gems produced a measured DPS-field contribution.');
    expect(text).toContain('Failed measurements:');
    expect(text).toContain('preview failed; restored=true');
  });

  it('treats unrestored previews as failed measurements', async () => {
    const luaClient = makeLuaClient({
      previewGemEnabled: jest.fn(async () => ({
        before: { FullDPS: 1000 },
        after: { FullDPS: 700 },
        restored: false,
      })),
    });

    const singleResult = await handleMeasureGemContribution(makeContext(luaClient), {
      group_index: 1,
      gem_index: 2,
    });

    const linkResult = await handleMeasureLinkContributions(makeContext(luaClient), {
      group_index: 1,
    });

    expect(singleResult.content[0].text).toContain('Measurement failed: preview did not restore original gem state');
    expect(singleResult.content[0].text).not.toContain('current_contribution: 300 FullDPS');
    expect(linkResult.content[0].text).toContain('Failed measurements:');
    expect(linkResult.content[0].text).toContain('preview did not restore original gem state');
  });

  it('adds measurement guardrails to recommendation-only gem tools', async () => {
    const suggestionResult = await handleSuggestSupportGems({
      buildService: { readBuild: jest.fn(async () => ({})) },
      skillGemService: {
        suggestSupportGems: jest.fn(() => [
          { gem: 'Elemental Focus Support', dpsIncrease: 12, reasoning: 'more damage', cost: '1c' },
        ]),
        analyzeSkillLinks: jest.fn(() => ({ activeSkill: { name: 'Kinetic Fusillade' } })),
      },
    } as any, { build_name: 'synthetic.xml' });

    const optimizationResult = await handleOptimizeSkillLinks({
      buildService: {
        readBuild: jest.fn(async () => ({
          Build: { className: 'Witch', ascendClassName: 'Elementalist' },
          Skills: {
            SkillSet: {
              Skill: {
                label: 'Main',
                slot: 'Body Armour',
                Gem: [
                  { name: 'Fireball', level: '20', quality: '20', enabled: 'true' },
                  { name: 'Controlled Destruction Support', level: '20', quality: '20', enabled: 'true' },
                ],
              },
            },
          },
        })),
      },
      pobDirectory: '',
      getLuaClient: jest.fn(() => null),
      ensureLuaClient: jest.fn(async () => undefined),
    } as any, 'synthetic.xml');

    expect(suggestionResult.content[0].text).toContain(LINK_GUARDRAIL);
    expect(optimizationResult.content[0].text).toContain(LINK_GUARDRAIL);
  });
});
