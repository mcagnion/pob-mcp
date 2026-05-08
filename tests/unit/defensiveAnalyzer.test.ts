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

      // Stone of Lazhwar is spell BLOCK, and spell-hit advice must not route
      // users toward stale Acrobatics / spell-dodge wording.
      const blockText = rec!.solutions.find((s) => s.startsWith('Spell Block:'));
      expect(blockText).toBeDefined();
      expect(blockText!).toContain('Stone of Lazhwar');
      expect(allText).not.toMatch(/Spell Dodge:/);
      expect(allText).not.toContain('Acrobatics');
      expect(allText).not.toContain('converts Spell Suppression Chance');

      // Phase Acrobatics is removed from the tree in current PoE1; advice
      // must not cite it.
      expect(allText).not.toContain('Phase Acrobatics');

      // Suppression wording must reflect chance + per-hit half-damage.
      const suppText = rec!.solutions.find((s) => s.startsWith('Spell Suppression:'));
      expect(suppText).toBeDefined();
      expect(suppText!).toContain('Suppression Chance');
      expect(suppText!).toContain('50% damage');
      expect(suppText!).not.toMatch(/\bdodge\b/i);
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
      // Keep exact flask magnitudes out unless they are source-verified for
      // the current game data snapshot.
      const flaskLine = rec!.solutions.find((s) => /Granite|Basalt/.test(s)) || '';
      expect(flaskLine).not.toMatch(/\+1500|20% more Armour|15% physical/i);
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

  describe('avoidance recommendation text', () => {
    it('does not recommend stale generic dodge or old Acrobatics wording', () => {
      const stats = {
        ...healthyStats(),
        Evasion: 0,
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        DodgeChance: 0,
        SpellDodgeChance: 0,
        BlockChance: 0,
        SpellBlockChance: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'avoidance', 'No significant avoidance');

      expect(rec).toBeDefined();
      const solutionText = rec!.solutions.join(' ');
      expect(solutionText).toContain('each suppressed hit takes 50% damage');
      expect(solutionText).toContain('Suppression Chance');
      expect(solutionText).not.toContain('Acrobatics keystone gives 30% attack/spell dodge');
      expect(solutionText).not.toMatch(/\bDodge:/);
    });

    it('defensive layer advice does not list generic dodge as a new avoidance target', () => {
      const stats = {
        ...healthyStats(),
        Evasion: 0,
        EffectiveSpellSuppressionChance: 0,
        SpellSuppressionChance: 0,
        DodgeChance: 0,
        SpellDodgeChance: 0,
        BlockChance: 0,
        SpellBlockChance: 0,
        PhysicalDamageReduction: 0,
        EnduranceChargesMax: 0,
        Armour: 0,
        LifeRegen: 0,
        LifeLeechGainRate: 0,
        ESRecharge: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'layers', 'defensive layers active');

      expect(rec).toBeDefined();
      const solutionText = rec!.solutions.join(' ');
      expect(solutionText).toContain('Avoidance: add evasion, spell suppression, or block');
      expect(solutionText).not.toMatch(/\bdodge\b/i);
    });
  });

  // Positive-pin tests: each citation below is verified against PoB Data
  // 3.28 (current). The intent is to catch silent removal of the verified
  // text — e.g., a future "cleanup" that turns named recommendations into
  // vague generic advice. If a citation needs to be replaced, update both
  // the analyzer and the assertion in the same diff.
  describe('verified citations remain pinned (PoB Data 3.28)', () => {
    it('uncapped resistance advice keeps Diamond Skin tree notable + Purity auras', () => {
      // Diamond Skin: TreeData/3_28/tree.lua name node verified.
      // Purity of Fire/Cold/Lightning: Data/Skills/act_str.lua aura skills.
      const stats = { ...healthyStats(), FireResist: 50 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'resistance', 'Uncapped');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Diamond Skin');
      expect(allText).toMatch(/Purity/);
    });

    it('low life pool advice keeps Constitution + Heart of Oak life wheels', () => {
      // Both names verified in TreeData/3_28/tree.lua.
      const stats = { ...healthyStats(), Life: 1500, EnergyShield: 0, TotalEHP: 0 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'life');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Constitution');
      expect(allText).toContain('Heart of Oak');
    });

    it('no-mitigation advice keeps Determination + Grace auras', () => {
      // Determination / Grace: Data/Skills/act_str.lua, act_dex.lua.
      const stats = {
        ...healthyStats(),
        Armour: 0,
        Evasion: 0,
        BlockChance: 0,
        PhysicalDamageReduction: 0,
        EnduranceChargesMax: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'mitigation');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Determination');
      expect(allText).toContain('Grace');
    });

    it('no-sustain advice keeps Vitality + Warlord\'s Mark + Wicked Ward', () => {
      // Vitality / Warlord's Mark: Data/Skills/* aura + curse.
      // Wicked Ward: TreeData/3_28/tree.lua keystone (line 60312).
      const stats = {
        ...healthyStats(),
        LifeRegen: 0,
        LifeLeechGainRate: 0,
        ESRecharge: 0,
      };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'sustain');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Vitality');
      expect(allText).toMatch(/Warlord['’]s Mark/);
      expect(allText).toContain('Wicked Ward');
    });

    it('spell-defense gap advice keeps Aegis Aurora + Glancing Blows', () => {
      // Aegis Aurora: Data/Uniques/shield.lua. Glancing Blows: tree keystone.
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
      expect(allText).toContain('Aegis Aurora');
      expect(allText).toContain('Glancing Blows');
    });

    it('phys max-hit advice keeps Molten Shell, Immortal Call, Lightning Coil, Cloak of Flame', () => {
      // All four verified: Data/Skills (guard skills) + Data/Uniques/body.lua.
      const stats = { ...healthyStats(), PhysicalMaximumHitTaken: PHYS_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Physical max hit');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Molten Shell');
      expect(allText).toContain('Immortal Call');
      expect(allText).toContain('Lightning Coil');
      expect(allText).toContain('Cloak of Flame');
    });

    it('elemental max-hit advice keeps Loreweave + Fortify cross-element scalers', () => {
      // Loreweave: Data/Uniques/body.lua. Fortify: Data/Skills/sup_str.lua.
      const stats = { ...healthyStats(), ColdMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Cold max hit');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Loreweave');
      expect(allText).toContain('Fortify');
    });

    it('chaos max-hit advice keeps verified shield suffixes + Hunter prefix + CI keystone', () => {
      // Suffixes "of Regularity" / "of Concord" / "of Harmony" verified
      // at Data/ModItem.lua:2049-2051. Hunter influence prefix max-chaos-res
      // verified at Data/ModItem.lua:5007-5009.
      const stats = { ...healthyStats(), ChaosMaximumHitTaken: ELEMENT_MAXHIT_HIGH - 1 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'maxhit', 'Chaos max hit');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toMatch(/of Regularity|of Concord|of Harmony/);
      expect(allText).toMatch(/Hunter/);
      expect(allText).toContain('Chaos Inoculation');
    });

    it('curse advice keeps Warding flask + "of the Owl" / "of the Kakapo" suffixes', () => {
      // FlaskBuffCurseEffect4/5 verified at Data/ModFlask.lua:178-179.
      const stats = { ...healthyStats(), CurseEffectOnSelf: 100 };
      const result = analyzeDefenses(stats);
      const rec = findRec(result.recommendations, 'curse');
      expect(rec).toBeDefined();
      const allText = rec!.solutions.join(' ');
      expect(allText).toContain('Warding');
      expect(allText).toMatch(/of the Owl|of the Kakapo/);
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
