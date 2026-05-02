import { describe, expect, it, jest } from '@jest/globals';
import { handleOptimizeSkillLinks } from '../../src/handlers/advancedOptimizationHandlers.js';

const LINK_GUARDRAIL =
  'Guardrail: before replacing supports, run measure_link_contributions on the loaded build; estimates here are structural and not a measured DPS ranking.';
const MEASURED_NOTICE = 'Measured link contributions were folded into this analysis';

interface FakeGem {
  index: number;
  name: string;
  enabled: boolean;
  isSupport: boolean;
  level?: number;
  quality?: number;
}

function makeMainGroup(gems: FakeGem[]) {
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

function buildXmlForGems(gems: FakeGem[]) {
  return {
    Build: { className: 'Witch', ascendClassName: 'Elementalist' },
    Skills: {
      SkillSet: {
        Skill: {
          label: 'Main',
          slot: 'Body Armour',
          Gem: gems.map((gem) => ({
            name: gem.name,
            level: '20',
            quality: '20',
            enabled: gem.enabled ? 'true' : 'false',
          })),
        },
      },
    },
  };
}

function makeContext(luaClient: any, gems: FakeGem[]) {
  return {
    buildService: {
      readBuild: jest.fn(async () => buildXmlForGems(gems)),
    },
    pobDirectory: '',
    getLuaClient: jest.fn(() => luaClient),
    ensureLuaClient: jest.fn(async () => undefined),
  } as any;
}

function makeLuaClient(gems: FakeGem[], previewMap: Record<number, { fullDPSAfter: number; restored?: boolean }> = {}, overrides: Record<string, any> = {}): any {
  return {
    isAlive: jest.fn(() => true),
    getBuildInfo: jest.fn(async () => ({ name: 'synthetic' })),
    getSkills: jest.fn(async () => makeMainGroup(gems)),
    getStats: jest.fn(async () => ({ TotalDPS: 1000, Life: 5000, EnergyShield: 0 })),
    getTree: jest.fn(async () => ({ classId: 3 })),
    loadBuildXml: jest.fn(async () => undefined),
    previewGemEnabled: jest.fn(async (params: any) => {
      const gemIndex = params?.gemIndex;
      const map = previewMap[gemIndex] ?? { fullDPSAfter: 1000 };
      return {
        before: { FullDPS: 1000, TotalDPS: 1000 } as Record<string, number>,
        after: { FullDPS: map.fullDPSAfter, TotalDPS: map.fullDPSAfter } as Record<string, number>,
        restored: map.restored !== false,
      };
    }),
    ...overrides,
  };
}

describe('handleOptimizeSkillLinks measurement integration', () => {
  it('default path runs no measurement and keeps the static guardrail', async () => {
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Inspiration Support', enabled: true, isSupport: true },
      { index: 3, name: 'Faster Casting Support', enabled: true, isSupport: true },
    ];
    const luaClient = makeLuaClient(gems);
    const result = await handleOptimizeSkillLinks(makeContext(luaClient, gems), 'synthetic.xml');
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).not.toHaveBeenCalled();
    expect(text).toContain(LINK_GUARDRAIL);
    expect(text).not.toContain(MEASURED_NOTICE);
    // Static warning still fires at original severity ('high', icon ⚠️)
    expect(text).toContain('No "more" damage multiplier supports on main skill');
  });

  it('downgrades the no_more_multiplier warning when measurement shows a context-sensitive contributor', async () => {
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Inspiration Support', enabled: true, isSupport: true },
      { index: 3, name: 'Faster Casting Support', enabled: true, isSupport: true },
    ];
    // Hypothermia disabled drops FullDPS from 1000 to 700 → 30% contribution (well above 10% threshold).
    const luaClient = makeLuaClient(gems, {
      1: { fullDPSAfter: 600 },   // active gem big drop
      2: { fullDPSAfter: 700 },   // Hypothermia: 30% measured contribution
      3: { fullDPSAfter: 980 },   // Faster Casting: 2% (below threshold)
    });
    const result = await handleOptimizeSkillLinks(makeContext(luaClient, gems), 'synthetic.xml', { measure: true });
    const text = result.content[0].text;

    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(3);
    expect(text).toContain(MEASURED_NOTICE);
    expect(text).not.toContain(LINK_GUARDRAIL); // measurement succeeded; only the measured notice trails
    expect(text).toContain('Measured Link Contributions');
    expect(text).toContain('Inspiration Support');
    expect(text).toContain('30.0%'); // contribution percentage formatted

    // The static "no more multipliers" warning is downgraded to low severity (info icon)
    // and references the measured equivalent.
    expect(text).toContain('Static classifier flagged 0 "more" multipliers');
    expect(text).toContain('Inspiration Support (30.0%)');
    expect(text).not.toContain('⚠️ No "more" damage multiplier supports on main skill');
  });

  it('keeps the static warning when measurement shows no contributors above threshold', async () => {
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Faster Casting Support', enabled: true, isSupport: true },
      { index: 3, name: 'Spell Cascade Support', enabled: true, isSupport: true },
    ];
    // Both supports below 10% threshold.
    const luaClient = makeLuaClient(gems, {
      1: { fullDPSAfter: 300 },
      2: { fullDPSAfter: 970 },
      3: { fullDPSAfter: 950 },
    });
    const result = await handleOptimizeSkillLinks(makeContext(luaClient, gems), 'synthetic.xml', { measure: true });
    const text = result.content[0].text;

    expect(text).toContain(MEASURED_NOTICE);
    expect(text).toContain('Measured Link Contributions');
    // Static warning still fires at high severity (the ⚠️ icon) because no measured equivalent.
    expect(text).toContain('⚠️ No "more" damage multiplier supports on main skill');
    expect(text).not.toContain('Static classifier flagged 0');
  });

  it('reports per-gem measurement failures, marks the run partial, and surfaces the partial-warning + guardrail trailer', async () => {
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Inspiration Support', enabled: true, isSupport: true },
      { index: 3, name: 'Faster Casting Support', enabled: true, isSupport: true },
    ];
    const luaClient = makeLuaClient(gems);
    luaClient.previewGemEnabled = jest.fn(async (params: any) => {
      const gemIndex = params?.gemIndex;
      if (gemIndex === 1) {
        return { before: { FullDPS: 1000 } as Record<string, number>, after: { FullDPS: 600 } as Record<string, number>, restored: true };
      }
      throw new Error('preview did not restore original gem state');
    });

    const result = await handleOptimizeSkillLinks(makeContext(luaClient, gems), 'synthetic.xml', { measure: true });
    const text = result.content[0].text;

    // Active gem measured (1 call), then Inspiration fails-with-restore-keyword and the loop aborts (1 more call = 2 total).
    expect(luaClient.previewGemEnabled).toHaveBeenCalledTimes(2);
    expect(text).toContain('Measured Link Contributions');
    expect(text).toContain('Inspiration Support (gem_index=2): measurement failed');
    // The third gem must be visibly marked as skipped so the user knows the loop aborted.
    expect(text).toContain('Faster Casting Support (gem_index=3): measurement failed (skipped after prior restore failure)');
    // Static analysis still runs.
    expect(text).toContain('No "more" damage multiplier supports on main skill');
    // Partial measurement must NOT trail with the bare success notice.
    expect(text).not.toContain('Measured link contributions were folded into this analysis');
    expect(text).toContain('Measured link contributions were partial');
    expect(text).toContain(LINK_GUARDRAIL);
  });

  it('does not double-count statically-classified supports when measurement also picks them up', async () => {
    // Elemental Focus is statically in MORE_MULTIPLIER_GEMS. Even if measurement shows it
    // contributing >=10%, the general recommendation must NOT report "1 static + 1 measured
    // equivalent = 2 total" — that would be the same gem counted twice and would silently
    // suppress the "need another more multiplier" advice.
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Elemental Focus Support', enabled: true, isSupport: true },
      { index: 3, name: 'Faster Casting Support', enabled: true, isSupport: true },
      { index: 4, name: 'Spell Cascade Support', enabled: true, isSupport: true },
      { index: 5, name: 'Arcane Surge Support', enabled: true, isSupport: true },
      { index: 6, name: 'Iron Will Support', enabled: true, isSupport: true },
    ];
    // Elemental Focus measures at 25% (>=10%, but already statically classified).
    // No other support clears the threshold.
    const luaClient = makeLuaClient(gems, {
      1: { fullDPSAfter: 600 },
      2: { fullDPSAfter: 750 },   // Elemental Focus: 25% — already a static more multiplier, must NOT count again
      3: { fullDPSAfter: 980 },   // 2%
      4: { fullDPSAfter: 970 },   // 3%
      5: { fullDPSAfter: 950 },   // 5% (below 10% threshold)
      6: { fullDPSAfter: 960 },   // 4%
    });
    const result = await handleOptimizeSkillLinks(makeContext(luaClient, gems), 'synthetic.xml', { measure: true });
    const text = result.content[0].text;

    // The general recommendation must still ask for another "more" multiplier and must NOT
    // claim a non-existent measured equivalent.
    expect(text).toContain('Main skill has only 1 "more" multiplier support(s)');
    expect(text).not.toContain('measured context-sensitive equivalent');
    // The group-level no_more_multiplier path also must not fire because static count is already 1.
    expect(text).not.toContain('Static classifier flagged 0 "more" multipliers');
  });

  it('falls back to static when measure=true but Lua bridge is not alive', async () => {
    const gems: FakeGem[] = [
      { index: 1, name: 'Fireball', enabled: true, isSupport: false },
      { index: 2, name: 'Inspiration Support', enabled: true, isSupport: true },
      { index: 3, name: 'Faster Casting Support', enabled: true, isSupport: true },
    ];
    const result = await handleOptimizeSkillLinks(
      {
        buildService: {
          readBuild: jest.fn(async () => buildXmlForGems(gems)),
        },
        pobDirectory: '',
        getLuaClient: jest.fn(() => null),
        ensureLuaClient: jest.fn(async () => undefined),
      } as any,
      'synthetic.xml',
      { measure: true }
    );
    const text = result.content[0].text;

    expect(text).toContain('Measurement requested but unavailable');
    expect(text).toContain('Lua bridge unavailable');
    expect(text).toContain(LINK_GUARDRAIL);
  });
});
