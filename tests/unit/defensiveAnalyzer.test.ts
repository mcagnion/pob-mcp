import { describe, it, expect } from '@jest/globals';
import {
  analyzeDefenses,
  formatDefensiveAnalysis,
  PHYS_MAXHIT_CRITICAL,
  PHYS_MAXHIT_HIGH,
  ELEMENT_MAXHIT_HIGH,
  type Recommendation,
} from '../../src/defensiveAnalyzer.js';

// A "healthy endgame" stats baseline. Tests override only the relevant
// fields so the surrounding context (resists capped, life pool good,
// regen + leech, no max-hit gap, anti-curse via reduced effect) doesn't
// leak issues into unrelated assertions.
function healthyStats(): Record<string, any> {
  return {
    Life: 5500,
    EnergyShield: 1500,
    TotalEHP: 80000,
    PhysicalDamageReduction: 35,
    EnduranceChargesMax: 4,
    Armour: 25000,
    Evasion: 0,
    BlockChance: 0,
    SpellBlockChance: 0,
    DodgeChance: 0,
    SpellDodgeChance: 0,
    EffectiveSpellSuppressionChance: 50,
    SpellSuppressionChance: 50,
    FireResist: 75,
    ColdResist: 75,
    LightningResist: 75,
    ChaosResist: 30,
    LifeRegen: 250,
    LifeLeechGainRate: 200,
    ManaRegen: 150,
    ESRecharge: 600,
    PhysicalMaximumHitTaken: 45000,
    FireMaximumHitTaken: 50000,
    ColdMaximumHitTaken: 50000,
    LightningMaximumHitTaken: 50000,
    ChaosMaximumHitTaken: 40000,
    CurseEffectOnSelf: 50,
  };
}

function findRec(
  recs: Recommendation[],
  category: Recommendation['category'],
  needle?: string
): Recommendation | undefined {
  return recs.find(
    (r) => r.category === category && (!needle || r.issue.includes(needle))
  );
}

describe('analyzeDefenses — gap detectors (retro #82)', () => {
  it('healthy build hits no missing-layer warnings', () => {
    const result = analyzeDefenses(healthyStats());
    expect(findRec(result.recommendations, 'avoidance', 'spell-hit defense')).toBeUndefined();
    expect(findRec(result.recommendations, 'maxhit')).toBeUndefined();
    expect(findRec(result.recommendations, 'curse')).toBeUndefined();
    expect(['excellent', 'good']).toContain(result.overallScore);
  });

  describe('spell-hit defense gap', () => {
    it('flags critical when suppression / spell block / spell dodge are all 0', () => {
      const stats = {
        ...healthyStats(),
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'avoidance', 'No spell-hit defense');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('critical');
    });

    it('does NOT count attack BlockChance as spell defense (Codex review)', () => {
      // Build with high attack BlockChance but zero spell-specific defense
      // — must still emit the spell-defense gap.
      const stats = {
        ...healthyStats(),
        BlockChance: 60,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'avoidance', 'spell-hit defense');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('critical');
    });

    it('does NOT count Evasion as spell defense (PoE1: evasion is attack-only)', () => {
      const stats = {
        ...healthyStats(),
        Evasion: 30000,
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
      };
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'avoidance', 'spell-hit defense')).toBeDefined();
    });

    it('passes when Spell Block alone covers the spell layer', () => {
      const stats = {
        ...healthyStats(),
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 35,
        SpellDodgeChance: 0,
      };
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'avoidance', 'spell-hit defense')).toBeUndefined();
    });

    it('spell defense advice text is mechanically valid (verified against PoB Data 3.26)', () => {
      const stats = {
        ...healthyStats(),
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'avoidance', 'spell-hit defense');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');

      // Items removed in earlier rounds (must stay removed)
      expect(allText).not.toContain('Cyclopean Coil'); // belt with ailment immunity, NOT spell dodge

      // Stone of Lazhwar is spell BLOCK, not spell DODGE — must appear under
      // the Spell Block bullet, never the Spell Dodge bullet.
      const blockText = rec!.solutions.find((s) => s.startsWith('Spell Block:'));
      const dodgeText = rec!.solutions.find((s) => s.startsWith('Spell Dodge:'));
      expect(blockText).toBeDefined();
      expect(dodgeText).toBeDefined();
      expect(blockText!).toContain('Stone of Lazhwar');
      expect(dodgeText!).not.toContain('Stone of Lazhwar');

      // Phase Acrobatics is removed from the tree in current PoE1; advice
      // must not cite it.
      expect(allText).not.toContain('Phase Acrobatics');

      // Suppression wording must reflect chance + per-hit half-damage.
      const suppText = rec!.solutions.find((s) => s.startsWith('Spell Suppression:'));
      expect(suppText).toBeDefined();
      expect(suppText!).toMatch(/each suppressed hit/i);
    });
  });

  describe('max hit ceiling gap', () => {
    it('flags physical critical when below PHYS_MAXHIT_CRITICAL', () => {
      const stats = { ...healthyStats(), PhysicalMaximumHitTaken: PHYS_MAXHIT_CRITICAL - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Physical max hit ceiling');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('critical');
    });

    it('flags physical high between critical and high thresholds', () => {
      const stats = { ...healthyStats(), PhysicalMaximumHitTaken: PHYS_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Physical max hit ceiling');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('high');
    });

    it('flags element high when below ELEMENT_MAXHIT_HIGH', () => {
      const stats = { ...healthyStats(), FireMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Fire max hit ceiling');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('high');
    });

    it('does NOT flag when MaxHit stat is missing or zero (no false positive)', () => {
      const stats = healthyStats();
      delete stats.PhysicalMaximumHitTaken;
      delete stats.FireMaximumHitTaken;
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'maxhit')).toBeUndefined();
    });

    it('chaos gap uses chaos-specific advice, not elemental flask/penetration text', () => {
      const stats = { ...healthyStats(), ChaosMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Chaos max hit ceiling');
      expect(rec).toBeDefined();
      const allText = [rec!.issue, ...rec!.solutions, rec!.impact || ''].join(' ');
      // Chaos remediation should NOT mention elemental flasks or penetration
      expect(allText).not.toMatch(/Topaz|Sapphire|Ruby/);
      expect(allText).not.toContain('elemental penetration');
      // Chaos remediation SHOULD mention chaos-specific options
      expect(allText).toMatch(/chaos resistance/i);
      expect(allText).toMatch(/Amethyst|Chaos Inoculation/);
    });

    it('elemental gap uses correct per-element flask (no cross-element bleed)', () => {
      const fireStats = { ...healthyStats(), FireMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const fireResult = analyzeDefenses(fireStats);
      const fireRec = findRec(fireResult.recommendations, 'maxhit', 'Fire max hit');
      expect(fireRec!.solutions.join(' ')).toContain('Ruby');
      expect(fireRec!.solutions.join(' ')).not.toContain('Sapphire');
      expect(fireRec!.solutions.join(' ')).not.toContain('Topaz');
    });

    it('phys gap advice does not miscategorise body armours as flasks (verified: Brass Dome is body armour)', () => {
      const stats = { ...healthyStats(), PhysicalMaximumHitTaken: PHYS_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Physical max hit');
      const allSolutions = rec!.solutions.join(' ');
      // Brass Dome was previously listed as a phys-reduction "flask" — wrong;
      // it's body armour. It must never appear as a flask anywhere in the
      // solutions list.
      const flaskMentions = rec!.solutions.filter((s) => /\bflask\b/i.test(s));
      for (const line of flaskMentions) {
        expect(line).not.toMatch(/Brass Dome/);
      }
      // Granite + Basalt are real flasks — at least one solution line must
      // name them as the flask choice.
      expect(allSolutions).toMatch(/Granite|Basalt/);
      // Granite Flask "+1500 to Armour" and Basalt Flask "20% more Armour"
      // (verified flask.lua:280-326) — they ramp armour, NOT flat phys
      // damage reduction.
      const flaskLine = rec!.solutions.find((s) => /Granite|Basalt/.test(s)) || '';
      expect(flaskLine).not.toMatch(/flat phys reduction|flat physical reduction/i);
      expect(flaskLine).toMatch(/[Aa]rmour|[Mm]itigation/);
      // Lightning Coil and Cloak of Flame remain valid as body-armour redirect
      // mentions.
      expect(allSolutions).toMatch(/Lightning Coil|Cloak of Flame/);
    });

    it('chaos gap does not include Bottled Faith (Sulphur/Consecrated Ground unique, not chaos res)', () => {
      const stats = { ...healthyStats(), ChaosMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Chaos max hit');
      expect(rec!.solutions.join(' ')).not.toContain('Bottled Faith');
    });
  });

  describe('curse mitigation gap', () => {
    it('flags medium when CurseEffectOnSelf at baseline (100) and PhysMaxHit healthy', () => {
      const stats = { ...healthyStats(), CurseEffectOnSelf: 100 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'curse');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('medium');
    });

    it('escalates to high when curse baseline + low PhysMaxHit (compound failure)', () => {
      const stats = {
        ...healthyStats(),
        CurseEffectOnSelf: 100,
        PhysicalMaximumHitTaken: PHYS_MAXHIT_HIGH - 1, // triggers high gap
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'curse');
      expect(rec).toBeDefined();
      expect(rec!.priority).toBe('high');
    });

    it('does NOT flag when CurseEffectOnSelf is reduced (anti-curse layer present)', () => {
      const stats = { ...healthyStats(), CurseEffectOnSelf: 50 };
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'curse')).toBeUndefined();
    });

    it('does NOT flag when CurseEffectOnSelf is 0 (Unaffected by Curses)', () => {
      const stats = { ...healthyStats(), CurseEffectOnSelf: 0 };
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'curse')).toBeUndefined();
    });

    it('does NOT flag when CurseEffectOnSelf stat missing (older Lua, no false positive)', () => {
      const stats = healthyStats();
      delete stats.CurseEffectOnSelf;
      const result = analyzeDefenses(stats);
      expect(findRec(result.recommendations, 'curse')).toBeUndefined();
    });

    it('curse advice cites only verified anti-curse sources (no Brass Dome / Aspect of Cat / Bottled Faith / Whispers of Doom)', () => {
      const stats = { ...healthyStats(), CurseEffectOnSelf: 100 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'curse');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');

      // PoB Data verified: these do NOT have anti-curse mods —
      // Brass Dome (body.lua) is armour + max ele res, no curse line.
      // Farrul's Bite / Aspect of the Cat (helmet.lua) has no curse-removal.
      // Bottled Faith (flask.lua) is Sulphur / Consecrated Ground, not curse.
      // Whispers of Doom is the additional-curse keystone (offensive), not anti-curse.
      expect(allText).not.toContain('Brass Dome');
      expect(allText).not.toContain('Aspect of Cat');
      expect(allText).not.toContain('Aspect of the Cat');
      expect(allText).not.toContain('Bottled Faith');
      expect(allText).not.toContain('Whispers of Doom');

      // Sublime Vision is a Prismatic Jewel unique (Generated.lua:612-619),
      // not a Watcher's Eye variant — even though its Zealotry mod sits
      // alongside Watcher's Eye mods in WatchersEye.lua. The recommendation
      // text must not call it a Watcher's Eye.
      const sublimeLine = rec!.solutions.find((s) => s.includes('Sublime Vision'));
      if (sublimeLine !== undefined) {
        expect(sublimeLine).not.toMatch(/Watcher's Eye/);
        expect(sublimeLine).toMatch(/Prismatic Jewel/);
      }

      // Verified anti-curse sources MUST appear (at least one).
      expect(allText).toMatch(/Warding|Atziri's Reflection|Sublime Vision|Curse and Chaos Resistance/);
    });
  });

  describe('overall verdict downgrade — MickaMirageHiero scenario', () => {
    it('drops overall verdict from excellent when retro #82 conditions are met', () => {
      // Reproduce the documented blind-spot case: solid mitigation + recovery
      // (would pass 2-of-3 layer count) but Spell Supp 0, no anti-curse,
      // PhysMaxHit at the pinnacle one-shot threshold.
      const stats = {
        ...healthyStats(),
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
        PhysicalMaximumHitTaken: 26980,
        CurseEffectOnSelf: 100,
      };
      const result = analyzeDefenses(stats);
      // Pre-fix: this scored 'excellent'. With 3 gap detectors firing
      // (spell +2, phys high +2, curse compound-high +1) issues = 5+ →
      // floor of fair, more likely poor.
      expect(['fair', 'poor']).toContain(result.overallScore);
      expect(findRec(result.recommendations, 'avoidance', 'spell-hit defense')).toBeDefined();
      expect(findRec(result.recommendations, 'maxhit', 'Physical')).toBeDefined();
      expect(findRec(result.recommendations, 'curse')).toBeDefined();
    });
  });

  describe('format output coverage', () => {
    it('includes Max Hit Ceilings section', () => {
      const result = analyzeDefenses(healthyStats());
      const formatted = formatDefensiveAnalysis(result);
      expect(formatted).toContain('Max Hit Ceilings');
      // Number format depends on system locale (toLocaleString) — allow any
      // grouping separator (comma, space, NBSP, dot) between the digits.
      expect(formatted).toMatch(/Physical:\s*45\D?000/);
    });

    it('includes Curse Mitigation section', () => {
      const result = analyzeDefenses(healthyStats());
      const formatted = formatDefensiveAnalysis(result);
      expect(formatted).toContain('Curse Mitigation');
      expect(formatted).toContain('reduced');
    });

    it('does not show "No critical issues" when gap recommendations fire', () => {
      const stats = {
        ...healthyStats(),
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        SpellBlockChance: 0,
        SpellDodgeChance: 0,
      };
      const result = analyzeDefenses(stats);
      const formatted = formatDefensiveAnalysis(result);
      expect(formatted).not.toContain('No critical issues found');
    });
  });
});
