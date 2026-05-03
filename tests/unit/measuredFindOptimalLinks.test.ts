import { describe, expect, it, jest } from '@jest/globals';
import { handleFindOptimalLinks } from '../../src/handlers/skillGemHandlers.js';
import { SkillGemService } from '../../src/services/skillGemService.js';

const MEASURED_NOTICE_PREFIX = 'Measured link contributions were folded into this analysis';
const MEASURED_PARTIAL_PREFIX = 'Measured link contributions were partial';

interface FakeLiveGem {
  index: number;
  name: string;
  enabled?: boolean;
  isSupport?: boolean;
}

function makeMinionBuild(): any {
  // Same setup as measuredSuggestSupportGems.test: Minion archetype detects
  // Summon Skeletons; Spell Echo Support is in avoid_supports → rated "poor"
  // → findWeakestSupport surfaces it as `replaces` on every suggestion.
  return {
    Skills: {
      SkillSet: {
        Skill: {
          slot: 'Body Armour',
          Gem: [
            { nameSpec: 'Summon Skeletons', level: 20, quality: 20 },
            { nameSpec: 'Spell Echo Support', level: 20, quality: 20 },
            { nameSpec: 'Faster Casting Support', level: 20, quality: 20 },
          ],
        },
      },
    },
  };
}

function makeLuaClient(
  gems: FakeLiveGem[],
  previewMap: Record<number, { fullDPSAfter: number; restored?: boolean; throwError?: string }> = {},
): any {
  return {
    isAlive: jest.fn(() => true),
    getBuildInfo: jest.fn(async () => ({ name: 'minion-test' })),
    getSkills: jest.fn(async () => ({
      mainSocketGroup: 1,
      groups: [
        {
          index: 1,
          label: 'Main 6L',
          slot: 'Body Armour',
          enabled: true,
          includeInFullDPS: true,
          gems: gems.map((g) => ({
            index: g.index,
            name: g.name,
            enabled: g.enabled !== false,
            isSupport: g.isSupport ?? g.name.includes('Support'),
            level: 20,
            quality: 20,
          })),
        },
      ],
    })),
    previewGemEnabled: jest.fn(async (params: any) => {
      const gemIndex = params?.gemIndex;
      const map = previewMap[gemIndex];
      if (map?.throwError) {
        throw new Error(map.throwError);
      }
      const after = map?.fullDPSAfter ?? 1000;
      return {
        before: { FullDPS: 1000, TotalDPS: 1000 } as Record<string, number>,
        after: { FullDPS: after, TotalDPS: after } as Record<string, number>,
        restored: map?.restored !== false,
      };
    }),
  };
}

function makeContext(luaClient: any): any {
  return {
    buildService: {
      readBuild: jest.fn(async () => makeMinionBuild()),
    },
    skillGemService: new SkillGemService(),
    pobDirectory: '',
    getLuaClient: jest.fn(() => luaClient),
    ensureLuaClient: jest.fn(async () => undefined),
  };
}

describe('handleFindOptimalLinks measure: opt-in', () => {
  it('default path runs no measurement, omits the baseline section, and emits no trailing notice', async () => {
    const luaClient = makeLuaClient([]);
    const result = await handleFindOptimalLinks(makeContext(luaClient), {
      build_name: 'minion-test',
      link_count: 6,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).not.toHaveBeenCalled();
    expect(text).toContain('🏆 Optimal Setup:');
    expect(text).toContain('=== Upgrade Path ===');
    expect(text).not.toContain('=== Measured Current Baseline ===');
    expect(text).not.toContain('Replaced gem measured:');
    expect(text).not.toContain(MEASURED_NOTICE_PREFIX);
    expect(text).not.toContain(MEASURED_PARTIAL_PREFIX);
    expect(text).not.toContain('Measurement requested but unavailable');
    // Static "(replace X)" still surfaces unannotated.
    expect(text).toMatch(/\(replace Spell Echo Support\)/);
  });

  it('emits the Measured Current Baseline section + Replaced gem measured: lines when measurement succeeds', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      { index: 2, name: 'Spell Echo Support', isSupport: true },
      { index: 3, name: 'Faster Casting Support', isSupport: true },
    ];
    // Active 40% (1000→600), Spell Echo 30% (1000→700, above threshold),
    // Faster Casting 5% (1000→950, below threshold).
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 700 },
      3: { fullDPSAfter: 950 },
    });
    const result = await handleFindOptimalLinks(makeContext(luaClient), {
      build_name: 'minion-test',
      link_count: 6,
      measure: true,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(3);
    // Baseline section present and ordered as the live group reports gems.
    expect(text).toContain('=== Measured Current Baseline ===');
    expect(text).toContain('Current configuration measured by disabling each gem one at a time (FullDPS)');
    expect(text).toMatch(/- Summon Skeletons \(active\): 40\.0% FullDPS contribution — at or above 10% threshold \(high cost to replace\)/);
    expect(text).toMatch(/- Spell Echo Support \(support\): 30\.0% FullDPS contribution — at or above 10% threshold \(high cost to replace\)/);
    expect(text).toMatch(/- Faster Casting Support \(support\): 5\.0% FullDPS contribution — below 10% threshold/);
    // Each Upgrade Path "(replace Spell Echo Support)" gets a Replaced gem measured: line.
    expect(text).toContain('Replaced gem measured: currently contributes 30.0% FullDPS — at or above 10% threshold; verify swap with measure_link_contributions before replacing');
    // Trailing success notice fires.
    expect(text).toContain(MEASURED_NOTICE_PREFIX);
    expect(text).not.toContain(MEASURED_PARTIAL_PREFIX);
  });

  it('marks failed gems in the baseline + emits the partial trailing notice on a restore-error abort', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      { index: 2, name: 'Spell Echo Support', isSupport: true },
      { index: 3, name: 'Faster Casting Support', isSupport: true },
    ];
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 700, throwError: 'preview did not restore original gem state' },
    });

    const result = await handleFindOptimalLinks(makeContext(luaClient), {
      build_name: 'minion-test',
      link_count: 6,
      measure: true,
    });
    const text = result.content[0].text;

    // Active gem (1) measured + Spell Echo (2) failed-with-restore → loop aborts after 2 calls.
    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(2);
    expect(text).toContain('=== Measured Current Baseline ===');
    expect(text).toMatch(/- Summon Skeletons \(active\): 40\.0% FullDPS contribution/);
    expect(text).toMatch(/- Spell Echo Support \(support\): measurement failed - preview did not restore original gem state/);
    expect(text).toMatch(/- Faster Casting Support \(support\): measurement failed - skipped after prior restore failure/);
    // Replaced gem line carries the failure too.
    expect(text).toContain('Replaced gem measured: failed - preview did not restore original gem state; static recommendation only');
    // Partial trailing notice; no bare success notice.
    expect(text).toContain(MEASURED_PARTIAL_PREFIX);
    expect(text).not.toMatch(/Measured link contributions were folded into this analysis(?!.*partial)/);
  });

  it('falls back to static when Lua bridge is not alive, with the unavailable trailing notice', async () => {
    const result = await handleFindOptimalLinks(makeContext(null), {
      build_name: 'minion-test',
      link_count: 6,
      measure: true,
    });
    const text = result.content[0].text;

    expect(text).not.toContain('=== Measured Current Baseline ===');
    expect(text).not.toContain('Replaced gem measured:');
    expect(text).toContain('Measurement requested but unavailable: Lua bridge unavailable');
    expect(text).not.toContain(MEASURED_NOTICE_PREFIX);
  });

  it('annotates Replaced gem as not-in-group when the live socket group is missing the replaced gem', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      // Note: no Spell Echo Support in the live group.
      { index: 2, name: 'Minion Damage Support', isSupport: true },
    ];
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 800 },
    });
    const result = await handleFindOptimalLinks(makeContext(luaClient), {
      build_name: 'minion-test',
      link_count: 6,
      measure: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('=== Measured Current Baseline ===');
    expect(text).toMatch(/- Minion Damage Support \(support\)/);
    expect(text).toContain('Replaced gem measured: Spell Echo Support not present in selected socket group; static recommendation only');
    expect(text).toContain(MEASURED_NOTICE_PREFIX);
  });
});
