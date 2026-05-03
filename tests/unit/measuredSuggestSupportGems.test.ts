import { describe, expect, it, jest } from '@jest/globals';
import { handleSuggestSupportGems } from '../../src/handlers/skillGemHandlers.js';
import { SkillGemService } from '../../src/services/skillGemService.js';

const LINK_GUARDRAIL =
  'Guardrail: before replacing supports, run measure_link_contributions on the loaded build; estimates here are structural and not a measured DPS ranking.';
const MEASURED_NOTICE_PREFIX = 'Measured link contributions were folded into this analysis';
const MEASURED_PARTIAL_PREFIX = 'Measured link contributions were partial';

interface FakeLiveGem {
  index: number;
  name: string;
  enabled?: boolean;
  isSupport?: boolean;
  level?: number;
  quality?: number;
}

function makeMinionBuild(): any {
  // Summon Skeletons matches the Minion archetype in SkillGemService;
  // Spell Echo Support is in the archetype's avoid_supports → rated "poor" →
  // findWeakestSupport returns Spell Echo so Replaces: "Spell Echo Support"
  // ends up on every recommendation.
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
            level: g.level ?? 20,
            quality: g.quality ?? 20,
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

describe('handleSuggestSupportGems measure: opt-in', () => {
  it('default path runs no measurement, shows bare Replaces lines, and emits no trailing notice', async () => {
    const luaClient = makeLuaClient([]);
    const result = await handleSuggestSupportGems(makeContext(luaClient), {
      build_name: 'minion-test',
      count: 3,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).not.toHaveBeenCalled();
    expect(text).toContain('Replaces: Spell Echo Support');
    // Bare line — no measured annotation appended.
    expect(text).not.toContain('Replaces: Spell Echo Support (measured');
    expect(text).toContain(LINK_GUARDRAIL);
    expect(text).not.toContain(MEASURED_NOTICE_PREFIX);
    expect(text).not.toContain(MEASURED_PARTIAL_PREFIX);
    expect(text).not.toContain('Measurement requested but unavailable');
  });

  it('annotates Replaces with above-threshold warning when measured contribution is high', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      { index: 2, name: 'Spell Echo Support', isSupport: true },
      { index: 3, name: 'Faster Casting Support', isSupport: true },
    ];
    // Spell Echo disabled drops FullDPS 1000 → 700 = 30% contribution (>= 10% threshold).
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 700 },
      3: { fullDPSAfter: 980 },
    });
    const result = await handleSuggestSupportGems(makeContext(luaClient), {
      build_name: 'minion-test',
      count: 3,
      measure: true,
    });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(3);
    // The Replaces line for Spell Echo carries the measured contribution and the
    // above-threshold warning.
    expect(text).toMatch(
      /Replaces: Spell Echo Support \(measured: currently contributes 30\.0% FullDPS — at or above 10% threshold; verify swap with measure_link_contributions before replacing\)/,
    );
    expect(text).toContain(MEASURED_NOTICE_PREFIX);
    expect(text).not.toContain(MEASURED_PARTIAL_PREFIX);
    expect(text).not.toContain('Measurement requested but unavailable');
  });

  it('annotates Replaces with below-threshold tag when measured contribution is small', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      { index: 2, name: 'Spell Echo Support', isSupport: true },
      { index: 3, name: 'Faster Casting Support', isSupport: true },
    ];
    // Spell Echo disabled drops FullDPS 1000 → 950 = 5% contribution (< 10% threshold).
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 950 },
      3: { fullDPSAfter: 980 },
    });
    const result = await handleSuggestSupportGems(makeContext(luaClient), {
      build_name: 'minion-test',
      count: 3,
      measure: true,
    });
    const text = result.content[0].text;

    expect(text).toMatch(
      /Replaces: Spell Echo Support \(measured: currently contributes 5\.0% FullDPS — below 10% threshold\)/,
    );
    expect(text).not.toContain('verify swap with measure_link_contributions before replacing');
    expect(text).toContain(MEASURED_NOTICE_PREFIX);
  });

  it('reports per-gem measurement failure on the Replaces line and emits the partial trailing notice', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      { index: 2, name: 'Spell Echo Support', isSupport: true },
      { index: 3, name: 'Faster Casting Support', isSupport: true },
    ];
    // Active gem measures fine, then Spell Echo throws a restore-keyword error
    // that aborts the measurement loop.
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 700, throwError: 'preview did not restore original gem state' },
    });

    const result = await handleSuggestSupportGems(makeContext(luaClient), {
      build_name: 'minion-test',
      count: 3,
      measure: true,
    });
    const text = result.content[0].text;

    // Active gem (1) measured + Spell Echo (2) failed-with-restore → loop aborts after 2 calls.
    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(2);
    expect(text).toMatch(
      /Replaces: Spell Echo Support \(measured: failed - preview did not restore original gem state; static recommendation only\)/,
    );
    // Partial trailing notice fires; bare success notice must NOT appear.
    expect(text).toContain(MEASURED_PARTIAL_PREFIX);
    expect(text).not.toMatch(/Measured link contributions were folded into this analysis(?!.*partial)/);
  });

  it('falls back to static recommendations and prints the unavailable trailer when Lua bridge is not alive', async () => {
    const result = await handleSuggestSupportGems(makeContext(null), {
      build_name: 'minion-test',
      count: 3,
      measure: true,
    });
    const text = result.content[0].text;

    expect(text).toContain('Replaces: Spell Echo Support');
    // No annotation since measurement never produced an entries map.
    expect(text).not.toContain('Replaces: Spell Echo Support (measured');
    expect(text).toContain('Measurement requested but unavailable: Lua bridge unavailable');
    // Header guardrail still printed (default path).
    expect(text).toContain(LINK_GUARDRAIL);
    expect(text).not.toContain(MEASURED_NOTICE_PREFIX);
  });

  it('annotates Replaces as not-in-group when the live socket group is missing the replaced gem', async () => {
    const liveGems: FakeLiveGem[] = [
      { index: 1, name: 'Summon Skeletons', isSupport: false },
      // Note: no Spell Echo Support in the live group — the static-side weakest
      // support points at a name that the measurement pass cannot find.
      { index: 2, name: 'Minion Damage Support', isSupport: true },
    ];
    const luaClient = makeLuaClient(liveGems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 800 },
    });
    const result = await handleSuggestSupportGems(makeContext(luaClient), {
      build_name: 'minion-test',
      count: 3,
      measure: true,
    });
    const text = result.content[0].text;

    expect(text).toMatch(
      /Replaces: Spell Echo Support \(measured: gem not present in selected socket group; static recommendation only\)/,
    );
    expect(text).toContain(MEASURED_NOTICE_PREFIX);
  });
});
