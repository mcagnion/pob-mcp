/**
 * Defensive Analyzer for Path of Building builds
 *
 * Evaluates builds against the three-layer defensive framework:
 *   1. Avoidance  — not getting hit or not taking full hits
 *      (evasion, spell suppression, spell dodge when exposed by PoB, block)
 *   2. Mitigation — reducing damage when you do get hit
 *      (armour/PDR, endurance charges, elemental resists)
 *   3. Recovery   — healing back up after damage
 *      (life/ES regen, leech, gain on hit, ES recharge)
 *
 * A good build has at least 2 of these layers.
 * An exceptional build has all 3, with strong values in each.
 */

// Endgame survivability thresholds (single physical hit ceiling).
// Pinnacle bosses regularly hit 30k+; below 25k a single hit can kill.
// Element MaxHits use the same "high" cutoff but no "critical" tier
// because phys is the dominant one-shot vector in PoE1.
export const PHYS_MAXHIT_CRITICAL = 25_000;
export const PHYS_MAXHIT_HIGH = 30_000;
export const ELEMENT_MAXHIT_HIGH = 30_000;

// CurseEffectOnSelf is the PoB output multiplier (% — 100 baseline,
// 0 = Unaffected by Curses). Above this we treat the build as
// having no anti-curse layer.
export const CURSE_EFFECT_NO_MITIGATION_PCT = 95;

export interface DefensiveAnalysis {
  resistances: ResistanceAnalysis;
  lifePool: LifePoolAnalysis;
  avoidance: AvoidanceAnalysis;
  mitigation: MitigationAnalysis;
  sustain: SustainAnalysis;
  maxHits: MaxHitAnalysis;
  curseMitigation: CurseMitigationAnalysis;
  recommendations: Recommendation[];
  overallScore: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
  defensiveLayerCount: number;
  defensiveLayerSummary: string[];
}

export interface ResistanceAnalysis {
  fire: { value: number; status: 'capped' | 'overcapped' | 'uncapped' };
  cold: { value: number; status: 'capped' | 'overcapped' | 'uncapped' };
  lightning: { value: number; status: 'capped' | 'overcapped' | 'uncapped' };
  chaos: { value: number; status: 'good' | 'low' | 'dangerous' };
  allCapped: boolean;
}

export interface LifePoolAnalysis {
  life: number;
  energyShield: number;
  total: number;
  ehp: number;
  status: 'excellent' | 'good' | 'adequate' | 'low' | 'critical';
  recommendation?: string;
}

export interface AvoidanceAnalysis {
  spellSuppression: number;
  dodge: number;
  spellDodge: number;
  block: number;
  evasionRating: number;
  estimatedEvadeChance: number;
  hasSignificantAvoidance: boolean;
  summary: string;
}

export interface MitigationAnalysis {
  armour: { value: number; effectiveness: string };
  evasion: { value: number; effectiveness: string };
  block: { value: number; effectiveness: string };
  spellBlock: { value: number; effectiveness: string };
  physicalDamageReduction: number;
  enduranceCharges: number;
  overall: 'excellent' | 'good' | 'fair' | 'poor' | 'none';
}

export interface SustainAnalysis {
  lifeRegen: { value: number; percentOfMax: number; status: string };
  manaRegen: { value: number; status: string };
  esRecharge: { value: number; status: string };
  hasLeech: boolean;
  overall: 'excellent' | 'good' | 'adequate' | 'poor';
}

export type RecommendationCategory =
  | 'resistance'
  | 'life'
  | 'mitigation'
  | 'sustain'
  | 'avoidance'
  | 'layers'
  | 'maxhit'
  | 'curse';

export interface MaxHitAnalysis {
  physical: number;
  fire: number;
  cold: number;
  lightning: number;
  chaos: number;
  // Damage types whose ceiling is below the endgame "high" threshold.
  // 'physical' is also flagged here when below PHYS_MAXHIT_CRITICAL.
  gaps: Array<{ type: 'physical' | 'fire' | 'cold' | 'lightning' | 'chaos'; value: number; severity: 'critical' | 'high' }>;
}

export interface CurseMitigationAnalysis {
  // PoB output: 100 = baseline, 0 = Unaffected by Curses, <100 = reduced.
  // null when the stat is absent (older Lua bridge); we don't warn on null
  // since there's no signal one way or the other.
  curseEffectOnSelf: number | null;
  status: 'immune' | 'reduced' | 'baseline' | 'amplified' | 'unknown';
}

export interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: RecommendationCategory;
  issue: string;
  solutions: string[];
  impact?: string;
}

/**
 * Analyze defensive stats from a build
 */
export function analyzeDefenses(stats: Record<string, any>): DefensiveAnalysis {
  const resistances = analyzeResistances(stats);
  const lifePool = analyzeLifePool(stats);
  const avoidance = analyzeAvoidance(stats);
  const mitigation = analyzeMitigation(stats);
  const sustain = analyzeSustain(stats);
  const maxHits = analyzeMaxHits(stats);
  const curseMitigation = analyzeCurseMitigation(stats);

  const recommendations: Recommendation[] = [];
  recommendations.push(...generateResistanceRecommendations(resistances));
  recommendations.push(...generateLifePoolRecommendations(lifePool));
  recommendations.push(...generateAvoidanceRecommendations(avoidance));
  recommendations.push(...generateSpellDefenseGapRecommendations(avoidance, mitigation));
  recommendations.push(...generateMitigationRecommendations(mitigation, stats));
  recommendations.push(...generateSustainRecommendations(sustain));
  recommendations.push(...generateMaxHitRecommendations(maxHits));
  recommendations.push(...generateCurseMitigationRecommendations(curseMitigation, maxHits));

  // Evaluate defensive layers
  const avoidanceLayer = avoidance.hasSignificantAvoidance;
  const mitigationLayer = mitigation.overall !== 'none' && mitigation.overall !== 'poor';
  const recoveryLayer = sustain.overall !== 'poor';

  const defensiveLayerCount = [avoidanceLayer, mitigationLayer, recoveryLayer].filter(Boolean).length;
  const defensiveLayerSummary: string[] = [];

  defensiveLayerSummary.push(
    `${avoidanceLayer ? '✓' : '✗'} Avoidance: ${avoidance.summary}`
  );
  defensiveLayerSummary.push(
    `${mitigationLayer ? '✓' : '✗'} Mitigation: ${mitigation.overall} (armour ${mitigation.armour.value.toLocaleString()}, PDR ${mitigation.physicalDamageReduction}%)`
  );
  defensiveLayerSummary.push(
    `${recoveryLayer ? '✓' : '✗'} Recovery: ${sustain.overall} (regen ${sustain.lifeRegen.percentOfMax.toFixed(1)}%/s${sustain.hasLeech ? ', has leech' : ''})`
  );

  if (defensiveLayerCount < 2) {
    recommendations.push({
      priority: 'high',
      category: 'layers',
      issue: `Only ${defensiveLayerCount} of 3 defensive layers active (avoidance / mitigation / recovery)`,
      solutions: [
        'Avoidance: add evasion, spell suppression, or block',
        'Mitigation: add armour (Determination aura), endurance charges, or physical reduction',
        'Recovery: add life regeneration, life leech, or gain-on-hit',
      ],
      impact: 'Builds with only one defensive layer are fragile — a single mechanic bypass kills you',
    });
  }

  recommendations.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.priority] - order[b.priority];
  });

  const overallScore = calculateOverallScore({
    resistances, lifePool, mitigation, sustain, defensiveLayerCount,
    avoidance, maxHits, curseMitigation,
  });

  return {
    resistances,
    lifePool,
    avoidance,
    mitigation,
    sustain,
    maxHits,
    curseMitigation,
    recommendations,
    overallScore,
    defensiveLayerCount,
    defensiveLayerSummary,
  };
}

function analyzeResistances(stats: Record<string, any>): ResistanceAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const fire = getStat('FireResist');
  const cold = getStat('ColdResist');
  const lightning = getStat('LightningResist');
  const chaos = getStat('ChaosResist');

  const getResistStatus = (value: number) => {
    if (value > 75) return 'overcapped' as const;
    if (value >= 75) return 'capped' as const;
    return 'uncapped' as const;
  };

  const getChaosStatus = (value: number) => {
    if (value >= 60) return 'good' as const;
    if (value >= 0) return 'low' as const;
    return 'dangerous' as const;
  };

  return {
    fire: { value: fire, status: getResistStatus(fire) },
    cold: { value: cold, status: getResistStatus(cold) },
    lightning: { value: lightning, status: getResistStatus(lightning) },
    chaos: { value: chaos, status: getChaosStatus(chaos) },
    allCapped: fire >= 75 && cold >= 75 && lightning >= 75,
  };
}

function analyzeLifePool(stats: Record<string, any>): LifePoolAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const life = getStat('Life');
  const es = getStat('EnergyShield');
  const total = life + es;

  // Use TotalEHP from PoB if available, otherwise estimate from PDR
  let ehp = getStat('TotalEHP');
  if (!ehp || ehp <= total) {
    const pdr = getStat('PhysicalDamageReduction');
    // Approximate EHP: raw HP / (1 - mitigation%), capped at 5× total
    if (pdr > 0 && pdr < 100) {
      ehp = Math.round(total / (1 - pdr / 100));
    } else {
      ehp = total;
    }
  }

  let status: LifePoolAnalysis['status'];
  let recommendation: string | undefined;

  if (total >= 6000) {
    status = 'excellent';
  } else if (total >= 4500) {
    status = 'good';
  } else if (total >= 3500) {
    status = 'adequate';
    recommendation = 'Consider adding more life/ES nodes or gear';
  } else if (total >= 2500) {
    status = 'low';
    recommendation = 'Life/ES is quite low — prioritize defensive nodes';
  } else {
    status = 'critical';
    recommendation = 'CRITICAL: Life/ES is dangerously low!';
  }

  return { life, energyShield: es, total, ehp, status, recommendation };
}

/**
 * Analyze avoidance layer:
 *   - Spell suppression (50%+ = full cap)
 *   - Evasion (gives % chance to evade attacks)
 *   - Spell dodge when exposed by PoB
 *   - Block
 */
function analyzeAvoidance(stats: Record<string, any>): AvoidanceAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const spellSuppression = getStat('EffectiveSpellSuppressionChance') || getStat('SpellSuppressionChance');
  const dodge = getStat('DodgeChance') || getStat('AttackDodgeChance');
  const spellDodge = getStat('SpellDodgeChance');
  const block = getStat('BlockChance');
  const evasionRating = getStat('Evasion');

  // Rough evade chance estimate: evasion / (evasion + attacker_accuracy)
  // At high tier content, attacker accuracy is roughly 5000–10000
  // This is a simplified estimate — PoB computes this more precisely
  const estimatedEvadeChance = evasionRating > 0
    ? Math.min(75, Math.round((evasionRating / (evasionRating + 7500)) * 100))
    : 0;

  const parts: string[] = [];
  if (spellSuppression >= 50) parts.push(`spell suppression ${spellSuppression}%`);
  else if (spellSuppression > 0) parts.push(`partial suppression ${spellSuppression}%`);
  if (estimatedEvadeChance >= 20) parts.push(`~${estimatedEvadeChance}% evade`);
  if (dodge >= 20) parts.push(`${dodge}% dodge`);
  if (spellDodge >= 20) parts.push(`${spellDodge}% spell dodge`);
  if (block >= 30) parts.push(`${block}% block`);

  // A meaningful avoidance layer means at least one solid avoidance mechanic:
  //   - 50% spell suppression (full cap)
  //   - OR evasion giving ≥30% evade chance
  //   - OR spell dodge ≥30%
  //   - OR block ≥30%
  const hasSignificantAvoidance =
    spellSuppression >= 50 ||
    estimatedEvadeChance >= 30 ||
    dodge >= 30 ||
    spellDodge >= 30 ||
    block >= 30;

  const summary = parts.length > 0 ? parts.join(', ') : 'none';

  return {
    spellSuppression,
    dodge,
    spellDodge,
    block,
    evasionRating,
    estimatedEvadeChance,
    hasSignificantAvoidance,
    summary,
  };
}

function analyzeMitigation(stats: Record<string, any>): MitigationAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const armour = getStat('Armour');
  const evasion = getStat('Evasion');
  const block = getStat('BlockChance');
  const spellBlock = getStat('SpellBlockChance');
  const physicalDamageReduction = Math.round(getStat('PhysicalDamageReduction'));
  const enduranceCharges = Math.round(getStat('EnduranceChargesMax') || 0);

  const getArmourEffectiveness = (value: number): string => {
    if (value >= 30000) return 'excellent (~40-50% phys reduction)';
    if (value >= 15000) return 'good (~25-35% phys reduction)';
    if (value >= 5000) return 'moderate (~10-20% phys reduction)';
    if (value >= 1000) return 'minimal (~3-8% phys reduction)';
    return 'negligible';
  };

  const getEvasionEffectiveness = (value: number): string => {
    if (value >= 30000) return 'excellent (~50-60% evade chance)';
    if (value >= 15000) return 'good (~35-45% evade chance)';
    if (value >= 5000) return 'moderate (~20-30% evade chance)';
    if (value >= 1000) return 'minimal (~5-15% evade chance)';
    return 'negligible';
  };

  const getBlockEffectiveness = (value: number): string => {
    if (value >= 60) return 'excellent (near cap)';
    if (value >= 40) return 'good';
    if (value >= 20) return 'moderate';
    if (value >= 10) return 'minimal';
    return 'none';
  };

  // Mitigation layer: meaningful if armour provides significant PDR, or endurance charges, or high block
  let overall: MitigationAnalysis['overall'];
  const hasStrongMitigation = physicalDamageReduction >= 30 || enduranceCharges >= 3 || block >= 40;
  const hasModerateMitigation = physicalDamageReduction >= 15 || armour >= 10000 || evasion >= 10000 || block >= 20;

  if (hasStrongMitigation && (armour >= 15000 || block >= 40)) {
    overall = 'excellent';
  } else if (hasStrongMitigation || (armour >= 15000 && block >= 20)) {
    overall = 'good';
  } else if (hasModerateMitigation) {
    overall = 'fair';
  } else if (armour >= 1000 || evasion >= 1000 || block >= 10) {
    overall = 'poor';
  } else {
    overall = 'none';
  }

  return {
    armour: { value: armour, effectiveness: getArmourEffectiveness(armour) },
    evasion: { value: evasion, effectiveness: getEvasionEffectiveness(evasion) },
    block: { value: block, effectiveness: getBlockEffectiveness(block) },
    spellBlock: { value: spellBlock, effectiveness: getBlockEffectiveness(spellBlock) },
    physicalDamageReduction,
    enduranceCharges,
    overall,
  };
}

function analyzeSustain(stats: Record<string, any>): SustainAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const lifeRegen = getStat('LifeRegen');
  const life = getStat('Life') || 1;
  const manaRegen = getStat('ManaRegen');
  const esRecharge = getStat('ESRecharge');
  const lifeLeechRate = getStat('LifeLeechGainRate');
  const hasLeech = lifeLeechRate > 0;

  const lifeRegenPercent = (lifeRegen / life) * 100;

  const getLifeRegenStatus = (percent: number): string => {
    if (percent >= 5) return 'excellent';
    if (percent >= 2) return 'good';
    if (percent >= 1) return 'adequate';
    if (percent > 0) return 'minimal';
    return 'none';
  };

  const getManaRegenStatus = (value: number): string => {
    if (value >= 200) return 'excellent';
    if (value >= 100) return 'good';
    if (value >= 50) return 'adequate';
    return 'low';
  };

  const getESRechargeStatus = (value: number): string => {
    if (value >= 1000) return 'excellent';
    if (value >= 500) return 'good';
    if (value >= 200) return 'adequate';
    return 'low or none';
  };

  // Recovery layer: meaningful if regen ≥1% or has leech or ES recharge
  let overall: SustainAnalysis['overall'];
  if (lifeRegenPercent >= 3 || esRecharge >= 800 || (hasLeech && lifeRegenPercent >= 1)) {
    overall = 'excellent';
  } else if (lifeRegenPercent >= 1.5 || esRecharge >= 400 || hasLeech) {
    overall = 'good';
  } else if (lifeRegenPercent >= 0.5 || esRecharge >= 100) {
    overall = 'adequate';
  } else {
    overall = 'poor';
  }

  return {
    lifeRegen: {
      value: lifeRegen,
      percentOfMax: lifeRegenPercent,
      status: getLifeRegenStatus(lifeRegenPercent),
    },
    manaRegen: { value: manaRegen, status: getManaRegenStatus(manaRegen) },
    esRecharge: { value: esRecharge, status: getESRechargeStatus(esRecharge) },
    hasLeech,
    overall,
  };
}

function analyzeMaxHits(stats: Record<string, any>): MaxHitAnalysis {
  const getStat = (key: string): number => {
    if (stats[key] !== undefined) return parseFloat(stats[key]) || 0;
    if (stats[`Player${key}`] !== undefined) return parseFloat(stats[`Player${key}`]) || 0;
    return 0;
  };

  const physical = getStat('PhysicalMaximumHitTaken');
  const fire = getStat('FireMaximumHitTaken');
  const cold = getStat('ColdMaximumHitTaken');
  const lightning = getStat('LightningMaximumHitTaken');
  const chaos = getStat('ChaosMaximumHitTaken');

  const gaps: MaxHitAnalysis['gaps'] = [];
  if (physical > 0 && physical < PHYS_MAXHIT_CRITICAL) {
    gaps.push({ type: 'physical', value: physical, severity: 'critical' });
  } else if (physical > 0 && physical < PHYS_MAXHIT_HIGH) {
    gaps.push({ type: 'physical', value: physical, severity: 'high' });
  }
  for (const [type, value] of [
    ['fire', fire], ['cold', cold], ['lightning', lightning], ['chaos', chaos],
  ] as const) {
    if (value > 0 && value < ELEMENT_MAXHIT_HIGH) {
      gaps.push({ type, value, severity: 'high' });
    }
  }

  return { physical, fire, cold, lightning, chaos, gaps };
}

function analyzeCurseMitigation(stats: Record<string, any>): CurseMitigationAnalysis {
  const raw = stats.CurseEffectOnSelf;
  // If the stat isn't present, the bridge / build doesn't expose curse output
  // (older Lua, build loaded before CalcDefence ran). Return 'unknown' so we
  // neither flag a false missing layer nor claim curse mitigation.
  if (raw === undefined || raw === null) {
    return { curseEffectOnSelf: null, status: 'unknown' };
  }
  const curseEffectOnSelf = parseFloat(raw) || 0;

  let status: CurseMitigationAnalysis['status'];
  if (curseEffectOnSelf <= 0) {
    status = 'immune';
  } else if (curseEffectOnSelf < CURSE_EFFECT_NO_MITIGATION_PCT) {
    status = 'reduced';
  } else if (curseEffectOnSelf <= 105) {
    status = 'baseline';
  } else {
    status = 'amplified';
  }

  return { curseEffectOnSelf, status };
}

function generateResistanceRecommendations(analysis: ResistanceAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  const uncapped: string[] = [];
  if (analysis.fire.status === 'uncapped') uncapped.push(`Fire (${analysis.fire.value}%)`);
  if (analysis.cold.status === 'uncapped') uncapped.push(`Cold (${analysis.cold.value}%)`);
  if (analysis.lightning.status === 'uncapped') uncapped.push(`Lightning (${analysis.lightning.value}%)`);

  if (uncapped.length > 0) {
    const needed = uncapped.map((r) => {
      const match = r.match(/\((-?\d+)%\)/);
      const current = match ? parseInt(match[1]) : 0;
      return 75 - current;
    });
    recs.push({
      priority: 'critical',
      category: 'resistance',
      issue: `Uncapped resistances: ${uncapped.join(', ')}`,
      solutions: [
        `Need +${Math.max(...needed)}% total to cap all`,
        'Check gear for resistance upgrades',
        'Consider passive tree nodes (Diamond Skin, prismatic nodes)',
        'Use Purity auras if desperate',
      ],
      impact: 'Uncapped resists = taking significantly more elemental damage',
    });
  }

  if (analysis.chaos.status === 'dangerous') {
    recs.push({
      priority: 'high',
      category: 'resistance',
      issue: `Chaos Resistance: ${analysis.chaos.value}% (negative)`,
      solutions: [
        'Allocate chaos resist nodes if convenient',
        'Upgrade gear with chaos resist when possible',
        'Amethyst flask can help in chaos damage zones',
      ],
      impact: 'Negative chaos resist amplifies chaos damage taken',
    });
  } else if (analysis.chaos.status === 'low') {
    recs.push({
      priority: 'low',
      category: 'resistance',
      issue: `Chaos Resistance: ${analysis.chaos.value}% (could be better)`,
      solutions: ['Consider upgrading when convenient', '30–60% chaos resist is comfortable'],
    });
  }

  return recs;
}

function generateLifePoolRecommendations(analysis: LifePoolAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  if (analysis.status === 'critical' || analysis.status === 'low') {
    recs.push({
      priority: analysis.status === 'critical' ? 'critical' : 'high',
      category: 'life',
      issue: `Total Life/ES: ${analysis.total.toLocaleString()} (${analysis.status})`,
      solutions: [
        'Prioritize life/ES nodes on passive tree',
        'Look for +maximum life on all gear pieces',
        'Consider Constitution, Heart of Oak, or other major life wheels',
        `Target: ${analysis.total < 3500 ? '4,000+' : '5,000+'} total life/ES`,
      ],
      impact: 'Low life pool = frequent deaths, especially to one-shots',
    });
  } else if (analysis.status === 'adequate') {
    recs.push({
      priority: 'medium',
      category: 'life',
      issue: `Life/ES is adequate (${analysis.total.toLocaleString()}) but could be better`,
      solutions: [
        'Look for opportunities to add life nodes without sacrificing too much damage',
        'Upgrade gear with higher life rolls when possible',
      ],
    });
  }
  return recs;
}

function generateAvoidanceRecommendations(analysis: AvoidanceAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  if (!analysis.hasSignificantAvoidance) {
    recs.push({
      priority: 'medium',
      category: 'avoidance',
      issue: 'No significant avoidance layer (no evasion, spell suppression, or block)',
      solutions: [
        'Evasion: equip evasion-based armour and run Grace aura',
        'Spell Suppression: each suppressed hit takes 50% damage; raise Suppression Chance with tree and gear',
        'Block: use a shield or staff and invest in block nodes',
      ],
      impact: 'Without avoidance, every hit lands at full effect — requires pure mitigation + recovery to survive',
    });
  } else if (analysis.spellSuppression > 0 && analysis.spellSuppression < 50) {
    recs.push({
      priority: 'low',
      category: 'avoidance',
      issue: `Spell suppression is ${analysis.spellSuppression}% — not at 50% cap`,
      solutions: [
        'Cap spell suppression at 50% for full benefit',
        'Additional suppression nodes or gear can reach the cap',
      ],
    });
  }
  return recs;
}

function generateMitigationRecommendations(
  analysis: MitigationAnalysis,
  stats: Record<string, any>
): Recommendation[] {
  const recs: Recommendation[] = [];
  if (analysis.overall === 'none' || analysis.overall === 'poor') {
    recs.push({
      priority: 'high',
      category: 'mitigation',
      issue: 'No meaningful physical damage mitigation',
      solutions: [
        'Run Determination (armour) or Grace (evasion) aura',
        'Look for armour/evasion on gear',
        'Endurance charges provide flat physical mitigation (4% per charge)',
        'Consider block if using shield or staff',
      ],
      impact: 'No mitigation = taking full physical damage from hits',
    });
  } else if (analysis.overall === 'fair') {
    recs.push({
      priority: 'medium',
      category: 'mitigation',
      issue: 'Physical mitigation could be improved',
      solutions: [
        'Stack more of your chosen defense (armour, evasion, or block)',
        'Consider hybrid defenses (e.g., armour + block)',
        'Quality on armour pieces adds significant defense',
      ],
    });
  }
  return recs;
}

// Spell hits bypass attack BlockChance and EvasionRating (PoE1: evasion is
// attack-only). Only SpellSuppression / SpellBlockChance / SpellDodgeChance
// reduce spell damage. A build with strong attack defense but no spell
// defense layer takes full spell damage every hit.
function generateSpellDefenseGapRecommendations(
  avoidance: AvoidanceAnalysis,
  mitigation: MitigationAnalysis
): Recommendation[] {
  const recs: Recommendation[] = [];
  const supp = avoidance.spellSuppression;
  const spellBlock = mitigation.spellBlock.value;
  const spellDodge = avoidance.spellDodge;

  const hasSpellDefense = supp >= 30 || spellBlock >= 30 || spellDodge >= 30;
  if (hasSpellDefense) return recs;

  const noSpellLayerAtAll = supp <= 0 && spellBlock <= 0 && spellDodge <= 0;
  recs.push({
    priority: noSpellLayerAtAll ? 'critical' : 'high',
    category: 'avoidance',
    issue: noSpellLayerAtAll
      ? 'No spell-hit defense (suppression 0, spell block 0, spell dodge 0)'
      : `Spell-hit defense is below threshold (suppression ${supp}%, spell block ${spellBlock}%, spell dodge ${spellDodge}%)`,
    solutions: [
      'Spell Suppression: each suppressed hit takes 50% damage; Suppression Chance caps at 100% (50% is the practical endgame floor) — clusters on Shadow/Ranger tree side',
      'Spell Block: Aegis Aurora shield, Stone of Lazhwar amulet, Glancing Blows keystone (doubles block chance, 65% damage taken from blocked hits)',
    ],
    impact: 'Spell hits land at full damage without spell-specific defense; attack BlockChance and Evasion do NOT mitigate spells',
  });
  return recs;
}

function maxHitSolutions(type: MaxHitAnalysis['gaps'][number]['type']): string[] {
  if (type === 'physical') {
    return [
      'Stack armour + endurance charges (Determination aura, Molten Shell guard skill, Immortal Call guard skill)',
      'Cap physical damage reduction (90% via tempering + endurance charges + flasks)',
      'Granite or Basalt flask improves physical-hit mitigation during effect',
      'Lightning Coil or Cloak of Flame body armour redirects a fraction of physical damage to elements',
    ];
  }
  if (type === 'chaos') {
    // Chaos has no penetration / Topaz-style flask story; remediation is
    // chaos-resistance ramp, max-chaos-res suffixes, Amethyst flask, and
    // CI as a drastic option.
    return [
      'Increase chaos resistance toward 75% cap (Curse and Chaos Resistance tree notable; chaos-res affixes on gear)',
      'Add a chaos-resist Amethyst flask for chaos-heavy content',
      'Push max chaos resistance via shield suffixes (of Regularity / Concord / Harmony) and Hunter-influence prefixes',
      'Chaos Inoculation keystone (CI): immune to chaos at the cost of life (ES build only)',
    ];
  }
  // Elemental (fire / cold / lightning)
  const label = type[0].toUpperCase() + type.slice(1);
  const flaskMap: Record<'fire' | 'cold' | 'lightning', string> = {
    fire: 'Ruby',
    cold: 'Sapphire',
    lightning: 'Topaz',
  };
  return [
    `Cap ${type} resistance and add overcap to absorb elemental penetration`,
    `Add a defensive flask (${flaskMap[type]}) for ${label} damage`,
    'Spell Suppression and Fortify scale max hits across elements',
    'Loreweave or another EHP-multiplier unique can lift all element ceilings',
  ];
}

function generateMaxHitRecommendations(analysis: MaxHitAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const gap of analysis.gaps) {
    const typeLabel = gap.type.charAt(0).toUpperCase() + gap.type.slice(1);
    const isPhysicalCritical = gap.type === 'physical' && gap.severity === 'critical';
    recs.push({
      priority: gap.severity,
      category: 'maxhit',
      issue: `${typeLabel} max hit ceiling: ${gap.value.toLocaleString()} (below ${
        isPhysicalCritical
          ? `${PHYS_MAXHIT_CRITICAL.toLocaleString()} pinnacle one-shot threshold`
          : `${ELEMENT_MAXHIT_HIGH.toLocaleString()} endgame threshold`
      })`,
      solutions: maxHitSolutions(gap.type),
      impact:
        gap.severity === 'critical'
          ? `Single ${typeLabel.toLowerCase()} hit can kill at endgame (pinnacle bosses, T16+ map mods)`
          : `Risk of one-shot from ${typeLabel.toLowerCase()} hits when stacked with map mods`,
    });
  }
  return recs;
}

function generateCurseMitigationRecommendations(
  analysis: CurseMitigationAnalysis,
  maxHits: MaxHitAnalysis
): Recommendation[] {
  const recs: Recommendation[] = [];
  if (analysis.status !== 'baseline' && analysis.status !== 'amplified') return recs;

  // Compound severity: low PhysMaxHit + Vulnerability fully landing is the
  // documented retro #82 failure mode (MickaMirageHiero PhysMaxHit ~27k).
  const physGapHighOrCritical = maxHits.gaps.some(
    (g) => g.type === 'physical' && (g.severity === 'high' || g.severity === 'critical')
  );
  const priority: Recommendation['priority'] = physGapHighOrCritical ? 'high' : 'medium';

  recs.push({
    priority,
    category: 'curse',
    issue:
      analysis.status === 'amplified'
        ? `Curses on you are amplified (${analysis.curseEffectOnSelf}% effect)`
        : `No anti-curse layer (curse effect on you is ${analysis.curseEffectOnSelf}% — baseline)`,
    solutions: [
      'Warding flask suffix removes curses on use; "of the Owl" / "of the Kakapo" suffixes reduce curse effect during flask effect',
      'Atziri\'s Reflection shield grants Unaffected by Curses',
      'Sublime Vision (Prismatic Jewel) — Zealotry variant grants Unaffected by Curses while affected by Zealotry',
      'Curse and Chaos Resistance tree notable: 6% reduced Effect of Curses on you (also +6% chaos resistance)',
    ],
    impact: physGapHighOrCritical
      ? `Vulnerability adds ~30-44% physical damage taken; with current physical max-hit ceiling this drops survivability into one-shot territory`
      : 'Vulnerability adds ~30-44% physical damage taken; Temporal Chains, Enfeeble, Despair compound resistance/recovery problems',
  });
  return recs;
}

function generateSustainRecommendations(analysis: SustainAnalysis): Recommendation[] {
  const recs: Recommendation[] = [];
  if (analysis.overall === 'poor') {
    recs.push({
      priority: 'medium',
      category: 'sustain',
      issue: 'No sustain mechanism (no regen, leech, or recharge)',
      solutions: [
        'Life builds: Allocate regen nodes (Vitality aura, life regen notables)',
        'Add life leech via skill gems (Warlord\'s Mark, leech support) or tree',
        'ES builds: Ensure ES recharge is working (avoid constant hits or use Wicked Ward)',
        'Gain on hit provides reliable recovery for fast-hitting builds',
        'Flasks help but are not a complete sustain solution for endgame bossing',
      ],
      impact: 'Without sustain, chip damage and DoTs are lethal; flask reliance fails on "no regen" maps',
    });
  }
  return recs;
}

interface OverallScoreInput {
  resistances: ResistanceAnalysis;
  lifePool: LifePoolAnalysis;
  mitigation: MitigationAnalysis;
  sustain: SustainAnalysis;
  defensiveLayerCount: number;
  avoidance: AvoidanceAnalysis;
  maxHits: MaxHitAnalysis;
  curseMitigation: CurseMitigationAnalysis;
}

// Gap penalties: keep load-bearing missing layers from being masked
// by 2-of-3 layer counts (retro #82). Each gap is independent.
function gapIssues(input: OverallScoreInput): number {
  let issues = 0;
  const spellSupp = input.avoidance.spellSuppression;
  const spellBlock = input.mitigation.spellBlock.value;
  const spellDodge = input.avoidance.spellDodge;
  if (spellSupp < 30 && spellBlock < 30 && spellDodge < 30) issues += 2;
  for (const gap of input.maxHits.gaps) {
    issues += gap.severity === 'critical' ? 3 : 2;
  }
  if (input.curseMitigation.status === 'baseline' || input.curseMitigation.status === 'amplified') {
    issues += 1;
  }
  return issues;
}

function calculateOverallScore(input: OverallScoreInput): DefensiveAnalysis['overallScore'] {
  const { resistances, lifePool, mitigation, sustain, defensiveLayerCount } = input;

  if (!resistances.allCapped || lifePool.status === 'critical') {
    return 'critical';
  }

  let issues = 0;
  if (lifePool.status === 'low') issues += 2;
  if (lifePool.status === 'adequate') issues += 1;
  if (mitigation.overall === 'none' || mitigation.overall === 'poor') issues += 2;
  if (mitigation.overall === 'fair') issues += 1;
  if (sustain.overall === 'poor') issues += 2;
  if (sustain.overall === 'adequate') issues += 1;
  if (resistances.chaos.status === 'dangerous') issues += 1;
  if (defensiveLayerCount < 2) issues += 2;
  if (defensiveLayerCount < 3) issues += 1;

  issues += gapIssues(input);

  if (issues === 0) return 'excellent';
  if (issues <= 2) return 'good';
  if (issues <= 4) return 'fair';
  return 'poor';
}

/**
 * Format defensive analysis as readable text
 */
export function formatDefensiveAnalysis(analysis: DefensiveAnalysis): string {
  let output = '=== Defensive Analysis ===\n\n';

  const scoreEmoji: Record<string, string> = {
    excellent: '✅',
    good: '✓',
    fair: '⚠️',
    poor: '⚠️',
    critical: '🚨',
  };
  output += `Overall: ${scoreEmoji[analysis.overallScore]} ${analysis.overallScore.toUpperCase()}\n`;
  output += `EHP: ${analysis.lifePool.ehp.toLocaleString()} (effective HP including mitigation)\n\n`;

  // Defensive Layers summary
  output += `**Defensive Layers: ${analysis.defensiveLayerCount}/3**\n`;
  for (const line of analysis.defensiveLayerSummary) {
    output += `  ${line}\n`;
  }
  output += '\n';

  // Resistances
  output += '**Resistances:**\n';
  const resistIcon = (status: string) => (status === 'capped' || status === 'overcapped' ? '✓' : '✗');
  output += `${resistIcon(analysis.resistances.fire.status)} Fire: ${analysis.resistances.fire.value}%\n`;
  output += `${resistIcon(analysis.resistances.cold.status)} Cold: ${analysis.resistances.cold.value}%\n`;
  output += `${resistIcon(analysis.resistances.lightning.status)} Lightning: ${analysis.resistances.lightning.value}%\n`;
  output += `  Chaos: ${analysis.resistances.chaos.value}% (${analysis.resistances.chaos.status})\n\n`;

  // Life Pool
  output += '**Life Pool:**\n';
  output += `Life: ${analysis.lifePool.life.toLocaleString()}\n`;
  if (analysis.lifePool.energyShield > 0) {
    output += `Energy Shield: ${analysis.lifePool.energyShield.toLocaleString()}\n`;
  }
  output += `Total: ${analysis.lifePool.total.toLocaleString()} (${analysis.lifePool.status})\n\n`;

  // Avoidance
  output += '**Avoidance Layer:**\n';
  if (analysis.avoidance.spellSuppression > 0) {
    const suppIcon = analysis.avoidance.spellSuppression >= 50 ? '✓' : '⚠';
    output += `${suppIcon} Spell Suppression: ${analysis.avoidance.spellSuppression}%${analysis.avoidance.spellSuppression >= 50 ? ' (capped)' : ' (below 50% cap)'}\n`;
  }
  if (analysis.avoidance.estimatedEvadeChance > 0) {
    output += `  Evasion: ${analysis.avoidance.evasionRating.toLocaleString()} (~${analysis.avoidance.estimatedEvadeChance}% evade)\n`;
  }
  if (analysis.avoidance.dodge > 0) {
    output += `  Dodge: ${analysis.avoidance.dodge}%\n`;
  }
  if (analysis.avoidance.spellDodge > 0) {
    output += `  Spell Dodge: ${analysis.avoidance.spellDodge}%\n`;
  }
  if (analysis.avoidance.block > 0) {
    output += `  Block: ${analysis.avoidance.block}%\n`;
  }
  if (!analysis.avoidance.hasSignificantAvoidance) {
    output += `  ⚠ No significant avoidance — all hits land at full effect\n`;
  }
  output += '\n';

  // Mitigation
  output += '**Mitigation Layer:**\n';
  output += `Armour: ${analysis.mitigation.armour.value.toLocaleString()} — ${analysis.mitigation.armour.effectiveness}\n`;
  if (analysis.mitigation.physicalDamageReduction > 0) {
    output += `Physical Damage Reduction: ${analysis.mitigation.physicalDamageReduction}%\n`;
  }
  if (analysis.mitigation.enduranceCharges > 0) {
    output += `Endurance Charges: ${analysis.mitigation.enduranceCharges} (${analysis.mitigation.enduranceCharges * 4}% phys reduction)\n`;
  }
  output += `Block: ${analysis.mitigation.block.value}% — ${analysis.mitigation.block.effectiveness}\n`;
  if (analysis.mitigation.spellBlock.value > 0) {
    output += `Spell Block: ${analysis.mitigation.spellBlock.value}% — ${analysis.mitigation.spellBlock.effectiveness}\n`;
  }
  output += `Overall: ${analysis.mitigation.overall}\n\n`;

  // Recovery (Sustain)
  output += '**Recovery Layer:**\n';
  output += `Life Regen: ${analysis.sustain.lifeRegen.value.toFixed(1)}/s (${analysis.sustain.lifeRegen.percentOfMax.toFixed(1)}% of max) — ${analysis.sustain.lifeRegen.status}\n`;
  if (analysis.sustain.hasLeech) {
    output += `Life Leech: active\n`;
  }
  if (analysis.sustain.esRecharge.value > 0) {
    output += `ES Recharge: ${analysis.sustain.esRecharge.value}/s — ${analysis.sustain.esRecharge.status}\n`;
  }
  output += `Overall: ${analysis.sustain.overall}\n\n`;

  // Max Hit Ceilings (single-hit survivability)
  output += '**Max Hit Ceilings (per-hit survivability):**\n';
  const mh = analysis.maxHits;
  const mhMark = (type: MaxHitAnalysis['gaps'][number]['type'], value: number): string => {
    if (value <= 0) return '?';
    const gap = analysis.maxHits.gaps.find((g) => g.type === type);
    if (!gap) return '✓';
    return gap.severity === 'critical' ? '🚨' : '⚠';
  };
  output += `${mhMark('physical', mh.physical)} Physical: ${mh.physical.toLocaleString()}\n`;
  output += `${mhMark('fire', mh.fire)} Fire: ${mh.fire.toLocaleString()}\n`;
  output += `${mhMark('cold', mh.cold)} Cold: ${mh.cold.toLocaleString()}\n`;
  output += `${mhMark('lightning', mh.lightning)} Lightning: ${mh.lightning.toLocaleString()}\n`;
  output += `${mhMark('chaos', mh.chaos)} Chaos: ${mh.chaos.toLocaleString()}\n\n`;

  // Curse Mitigation
  output += '**Curse Mitigation:**\n';
  let curseIcon: string;
  if (analysis.curseMitigation.status === 'immune' || analysis.curseMitigation.status === 'reduced') {
    curseIcon = '✓';
  } else if (analysis.curseMitigation.status === 'amplified') {
    curseIcon = '🚨';
  } else if (analysis.curseMitigation.status === 'unknown') {
    curseIcon = '?';
  } else {
    curseIcon = '⚠';
  }
  const curseValue = analysis.curseMitigation.curseEffectOnSelf;
  const curseValueLabel = curseValue === null ? 'not exposed by bridge' : `${curseValue}%`;
  output += `${curseIcon} Curse Effect on you: ${curseValueLabel} (${analysis.curseMitigation.status})\n\n`;

  // Recommendations
  if (analysis.recommendations.length > 0) {
    output += '**Recommendations:**\n\n';
    for (let i = 0; i < analysis.recommendations.length; i++) {
      const rec = analysis.recommendations[i];
      const priorityIcon: Record<string, string> = {
        critical: '🚨',
        high: '⚠️',
        medium: '○',
        low: '·',
      };
      output += `${i + 1}. ${priorityIcon[rec.priority]} [${rec.priority.toUpperCase()}] ${rec.issue}\n`;
      for (const solution of rec.solutions) {
        output += `   → ${solution}\n`;
      }
      if (rec.impact) {
        output += `   Impact: ${rec.impact}\n`;
      }
      output += '\n';
    }
  } else {
    output += '**No critical issues found!** Defenses look solid.\n';
  }

  return output;
}
