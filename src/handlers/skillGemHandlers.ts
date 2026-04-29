import type { BuildService } from "../services/buildService.js";
import type { SkillGemService } from "../services/skillGemService.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface SkillGemHandlerContext {
  buildService: BuildService;
  skillGemService: SkillGemService;
  pobDirectory?: string;
  getLuaClient?: () => PoBLuaApiClient | null;
  ensureLuaClient?: () => Promise<void>;
}

const GEM_MECHANICS_FRESHNESS_NOTE =
  'Gem quality, corruption outcomes, and Exceptional/alternate gem availability are version-sensitive. Verify with current PoB gem data and post-change stat readback before buying or corrupting.';

const GEM_QUALITY_PREVIEW_FIELDS = [
  'FullDPS',
  'FullDotDPS',
  'TotalDPS',
  'CombinedDPS',
  'TotalDotDPS',
  'Speed',
  'ManaCost',
];

const GEM_QUALITY_DPS_PRIORITY_FIELDS = [
  'FullDPS',
  'TotalDPS',
  'CombinedDPS',
  'FullDotDPS',
  'TotalDotDPS',
];

interface SkillSelectorArgs {
  skill_index?: number;
  skill_name?: string;
}

interface ExtractedSkillGroup {
  index: number;
  gems: any[];
  slot: string;
  activeSkillName: string;
  isMain: boolean;
  isEnabled: boolean;
  isInActiveSet: boolean;
}

interface ResolvedSkillSelection {
  index: number;
  skillName: string;
  reason: string;
}

interface GemQualityMeasurement {
  restored: boolean;
  before: Record<string, any>;
  after: Record<string, any>;
  restoredStats?: Record<string, any>;
  targetQuality: number;
  dpsScore: number | null;
  error?: string;
}

function gemName(gem: any): string {
  return gem?.nameSpec || gem?.name || gem?.gemId || "Unknown Skill";
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function isFalsey(value: unknown): boolean {
  return value === false || value === 0 || value === "false" || value === "0";
}

function resolveSkillSelection(build: any, args?: SkillSelectorArgs): ResolvedSkillSelection {
  const skills = extractSkills(build);
  if (skills.length === 0) {
    throw new Error("No skill groups found in build.");
  }

  if (args?.skill_name?.trim()) {
    const requested = args.skill_name.trim().toLowerCase();
    const match = skills.find((skill) => skill.activeSkillName.toLowerCase() === requested);
    if (!match) {
      const available = skills.map((skill) => `${skill.index}: ${skill.activeSkillName}`).join(", ");
      throw new Error(`Skill "${args.skill_name}" not found. Available skills: ${available}`);
    }
    return {
      index: match.index,
      skillName: match.activeSkillName,
      reason: `matched skill_name="${args.skill_name.trim()}"`,
    };
  }

  if (args?.skill_index !== undefined) {
    if (!Number.isInteger(args.skill_index) || args.skill_index < 0 || args.skill_index >= skills.length) {
      throw new Error(`skill_index ${args.skill_index} not found. Build has ${skills.length} skill group(s).`);
    }
    const selected = skills[args.skill_index];
    return {
      index: selected.index,
      skillName: selected.activeSkillName,
      reason: "explicit zero-based skill_index",
    };
  }

  const selected =
    skills.find((skill) => skill.isMain) ||
    skills.find((skill) => skill.isInActiveSet && skill.isEnabled) ||
    skills[0];

  return {
    index: selected.index,
    skillName: selected.activeSkillName,
    reason: selected.isMain
      ? "defaulted to XML mainActiveSkill group"
      : "defaulted to first enabled skill group",
  };
}

function formatGemLocation(location?: {
  skillIndex: number;
  groupIndex: number;
  gemIndex: number;
  slot: string;
  activeSkillName: string;
}): string {
  if (!location) {
    return "unknown location";
  }
  return `slot=${location.slot}, group_index=${location.groupIndex}, skill_index=${location.skillIndex}, gem_index=${location.gemIndex}, active_skill=${location.activeSkillName}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function numericStat(stats: Record<string, any> | undefined, field: string): number | null {
  if (!stats || stats[field] == null) return null;
  const value = Number(stats[field]);
  return Number.isFinite(value) ? value : null;
}

function formatMeasuredDelta(field: string, before: number, after: number): string {
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  const percent = before !== 0
    ? `, ${sign}${formatNumber((delta / before) * 100)}%`
    : '';
  return `${field}: ${formatNumber(before)} -> ${formatNumber(after)} (${sign}${formatNumber(delta)}${percent})`;
}

function gemLocationKey(location: { groupIndex: number; gemIndex: number }): string {
  return `${location.groupIndex}:${location.gemIndex}`;
}

function normalizeBuildName(name: string | undefined): string {
  return (name ?? '').replace(/\.xml$/i, '').trim().toLowerCase();
}

function measurementDpsScore(measurement: GemQualityMeasurement): number | null {
  for (const field of GEM_QUALITY_DPS_PRIORITY_FIELDS) {
    const before = numericStat(measurement.before, field);
    const after = numericStat(measurement.after, field);
    if (before != null && after != null) {
      return after - before;
    }
  }
  return null;
}

function measurementDeltaLines(measurement: GemQualityMeasurement): string[] {
  const changedLines: string[] = [];
  for (const field of GEM_QUALITY_PREVIEW_FIELDS) {
    const before = numericStat(measurement.before, field);
    const after = numericStat(measurement.after, field);
    if (before == null || after == null) continue;
    if (before !== after) {
      changedLines.push(formatMeasuredDelta(field, before, after));
    }
  }
  return changedLines;
}

async function measureGemQuality(
  context: SkillGemHandlerContext,
  buildName: string,
  recommendations: Array<{ location: { groupIndex: number; gemIndex: number } }>
): Promise<{
  measurements: Map<string, GemQualityMeasurement>;
  note: string;
}> {
  const measurements = new Map<string, GemQualityMeasurement>();

  const luaClient = context.getLuaClient?.() ?? null;
  if (!luaClient || !luaClient.isAlive()) {
    return {
      measurements,
      note: 'Live measurement unavailable: Lua bridge is not active. Use lua_load_build for this build, then rerun validate_gem_quality.',
    };
  }

  try {
    const info = await luaClient.getBuildInfo();
    const loadedName = normalizeBuildName(info?.name ?? info?.buildName);
    const requestedName = normalizeBuildName(buildName);
    if (loadedName && requestedName && loadedName !== requestedName) {
      return {
        measurements,
        note: `Live measurement skipped: Lua bridge has "${info?.name ?? info?.buildName}" loaded, not "${buildName}". Use lua_load_build("${buildName}") first.`,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      measurements,
      note: `Live measurement unavailable: could not read loaded build info (${msg}). Use lua_load_build for this build, then rerun validate_gem_quality.`,
    };
  }

  for (const recommendation of recommendations) {
    const key = gemLocationKey(recommendation.location);
    try {
      const preview = await luaClient.previewGemQuality({
        groupIndex: recommendation.location.groupIndex,
        gemIndex: recommendation.location.gemIndex,
        quality: 20,
        fields: GEM_QUALITY_PREVIEW_FIELDS,
      });
      const measurement: GemQualityMeasurement = {
        restored: preview.restored === true,
        before: preview.before ?? {},
        after: preview.after ?? {},
        restoredStats: preview.restoredStats,
        targetQuality: 20,
        dpsScore: null,
      };
      measurement.dpsScore = measurementDpsScore(measurement);
      measurements.set(key, measurement);
    } catch (error) {
      measurements.set(key, {
        restored: false,
        before: {},
        after: {},
        targetQuality: 20,
        dpsScore: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    measurements,
    note: 'Live measurement: non-destructive gem-quality preview via PoB bridge; original gem quality restored after each candidate.',
  };
}

/**
 * Handle analyze_skill_links tool call
 */
export async function handleAnalyzeSkillLinks(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; skill_index?: number; skill_name?: string }
) {
  return wrapHandler('analyze skill links', async () => {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const selection = resolveSkillSelection(buildData, args);
  const skillIndex = selection.index;

  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);

  // Format output
  const outputLines: string[] = [
    `=== Skill Analysis: ${analysis.activeSkill.name} ===`,
    '',
    `Selected Skill: ${selection.skillName} (index ${skillIndex}; ${selection.reason})`,
    `Active Skill: ${analysis.activeSkill.name} (Level ${analysis.activeSkill.level}/${analysis.activeSkill.quality})`,
    `Tags: ${analysis.activeSkill.tags.join(", ")}`,
    `Archetype: ${analysis.archetype}`,
    '',
    `=== Support Gems (${analysis.linkCount}-Link) ===`,
  ];

  for (let i = 0; i < analysis.supports.length; i++) {
    const support = analysis.supports[i];
    const symbol = support.rating === "excellent" ? "✓" : support.rating === "poor" ? "✗" : "⚠";

    outputLines.push(`${i + 1}. ${symbol} ${support.name} (${support.level}/${support.quality}) - ${
      support.rating.charAt(0).toUpperCase() + support.rating.slice(1)
    }`);

    if (support.issues && support.issues.length > 0) {
      for (const issue of support.issues) {
        outputLines.push(`   ⚠ ${issue}`);
      }
    }

    if (support.recommendations && support.recommendations.length > 0) {
      for (const rec of support.recommendations) {
        outputLines.push(`   → ${rec}`);
      }
    }
  }

  if (analysis.issues.length > 0) {
    outputLines.push('', '=== Issues Detected ===');
    for (const issue of analysis.issues) {
      outputLines.push(`⚠ ${issue}`);
    }
  }

  outputLines.push(`\n=== Archetype Match: ${Math.round(analysis.archetypeMatch)}% ===`);
  if (analysis.archetypeMatch >= 80) {
    outputLines.push(`Strong alignment with "${analysis.archetype}" archetype`);
  } else if (analysis.archetypeMatch >= 60) {
    outputLines.push(`Moderate alignment with "${analysis.archetype}" archetype`);
  } else {
    outputLines.push(`Weak alignment with "${analysis.archetype}" archetype - consider reviewing gem choices`);
  }

  outputLines.push('', '💡 Use suggest_support_gems to see recommended improvements');
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Handle suggest_support_gems tool call
 */
export async function handleSuggestSupportGems(
  context: SkillGemHandlerContext,
  args?: {
    build_name?: string;
    skill_index?: number;
    skill_name?: string;
    count?: number;
    include_exceptional?: boolean;
    budget?: "league_start" | "mid_league" | "endgame";
  }
) {
  return wrapHandler('suggest support gems', async () => {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const selection = resolveSkillSelection(buildData, args);
  const skillIndex = selection.index;

  const suggestions = skillGemService.suggestSupportGems(buildData, skillIndex, {
    count: args.count,
    includeExceptional: args.include_exceptional,
    budget: args.budget,
  });

  // Get current analysis for context
  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);

  // Format output
  const outputLines: string[] = [
    `=== Support Gem Recommendations for ${analysis.activeSkill.name} ===`,
    '',
    `Selected Skill: ${selection.skillName} (index ${skillIndex}; ${selection.reason})`,
    '',
  ];

  if (suggestions.length === 0) {
    outputLines.push('No recommendations found. Your current setup appears optimal!');
    return {
      content: [
        {
          type: "text" as const,
          text: outputLines.join('\n'),
        },
      ],
    };
  }

  outputLines.push(`Top ${suggestions.length} Recommendations:`, '');
  outputLines.push('Verification gates: DPS is heuristic unless marked measured; acquisition and price require current league checks.', '');

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];

    outputLines.push(`${i + 1}. ${suggestion.gem}`);
    if (suggestion.replaces) {
      outputLines.push(`   Replaces: ${suggestion.replaces}`);
    }
    outputLines.push(`   Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    outputLines.push(`   Measured: ${suggestion.measured}`);
    outputLines.push(`   Acquirable: ${suggestion.acquirable}`);
    outputLines.push(`   Price-checked: ${suggestion.priceChecked ? "yes" : "no"}`);
    outputLines.push(`   Why: ${suggestion.reasoning}`);
    outputLines.push(`   Price: ${suggestion.cost}`);
    for (const note of suggestion.feasibilityNotes) {
      outputLines.push(`   Note: ${note}`);
    }

    if (suggestion.requires && suggestion.requires.length > 0) {
      outputLines.push(`   Requires: ${suggestion.requires.join(", ")}`);
    }

    if (suggestion.conflicts && suggestion.conflicts.length > 0) {
      outputLines.push(`   ⚠ Conflicts: ${suggestion.conflicts.join(", ")}`);
    }

    outputLines.push('');
  }

  // Add budget-specific recommendations
  const budget = args.budget || "endgame";
  const bestBudget = suggestions.find((s) => s.cost.includes("Chaos"));
  const bestEndgame = suggestions.find((s) => s.dpsIncrease === Math.max(...suggestions.map((s) => s.dpsIncrease)));

  if (bestBudget && budget === "endgame") {
    outputLines.push(`💡 Best Bang-for-Buck: ${bestBudget.gem} (+${bestBudget.dpsIncrease.toFixed(1)}% for ${bestBudget.cost})`);
  }
  if (bestEndgame) {
    outputLines.push(`💡 ${budget === "endgame" ? "Endgame" : "Best"} Priority: ${bestEndgame.gem} (+${bestEndgame.dpsIncrease.toFixed(1)}%)`);
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Handle compare_gem_setups tool call
 */
export async function handleCompareGemSetups(
  context: SkillGemHandlerContext,
  args: {
    build_name: string;
    skill_index?: number;
    skill_name?: string;
    setups: Array<{ name: string; gems: string[] }>;
  }
) {
  const { buildService, pobDirectory, getLuaClient, ensureLuaClient } = context;

  if (!args.build_name) {
    throw new Error("build_name is required");
  }

  if (!args.setups || args.setups.length < 2) {
    throw new Error("At least 2 setups are required for comparison");
  }

  const buildData = await buildService.readBuild(args.build_name);

  // Get active skill name for context
  const selection = resolveSkillSelection(buildData, args);
  const activeSkillName = selection.skillName;

  const outputLines: string[] = [
    `=== Gem Setup Comparison for ${activeSkillName} ===`,
    '',
    `Selected Skill: ${activeSkillName} (index ${selection.index}; ${selection.reason})`,
    '',
    'NOTE: Live DPS simulation per-setup is not yet supported (gem-swap requires PoB API extension).',
    'Showing structural analysis of each setup.',
    '',
  ];

  // Known "more" multiplier support gems
  const MORE_MULTIPLIERS = new Set([
    'Controlled Destruction', 'Elemental Focus', 'Concentrated Effect',
    'Multistrike', 'Faster Attacks', 'Faster Casting', 'Spell Echo',
    'Brutality', 'Void Manipulation', 'Swift Affliction', 'Efficacy',
    'Empower', 'Intensify', 'Infused Channelling', 'Close Combat',
    'Exceptional Controlled Destruction', 'Exceptional Elemental Focus',
    'Exceptional Void Manipulation', 'Exceptional Brutality',
    'Exceptional Swift Affliction', 'Exceptional Efficacy',
  ]);
  const PENETRATION_GEMS = new Set([
    'Fire Penetration', 'Cold Penetration', 'Lightning Penetration',
    'Combustion', 'Energy Leech', 'Ice Bite',
    'Exceptional Fire Penetration', 'Exceptional Cold Penetration', 'Exceptional Lightning Penetration',
  ]);

  for (let i = 0; i < args.setups.length; i++) {
    const setup = args.setups[i];
    const letter = String.fromCharCode(65 + i);
    const moreCount = setup.gems.filter(g => MORE_MULTIPLIERS.has(g)).length;
    const hasPen = setup.gems.some(g => PENETRATION_GEMS.has(g));

    outputLines.push(`Setup ${letter}: "${setup.name}"`);
    outputLines.push(`  Gems (${setup.gems.length}-link): ${setup.gems.join(", ")}`);
    let moreLine = `  "More" multipliers: ${moreCount}`;
    if (setup.gems.length >= 5 && moreCount < 2) moreLine += ` ⚠ (low for a ${setup.gems.length}-link)`;
    outputLines.push(moreLine);
    let penLine = `  Penetration: ${hasPen ? 'Yes' : 'None'}`;
    if (!hasPen) penLine += ` ⚠`;
    outputLines.push(penLine, '');
  }

  outputLines.push('=== Note ===');
  outputLines.push('For accurate DPS comparison, use add_gem + lua_get_stats to manually test each setup.');
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle validate_gem_quality tool call
 */
export async function handleValidateGemQuality(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; include_corrupted?: boolean }
) {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);

  const validation = skillGemService.validateGemQuality(buildData, {
    includeCorrupted: args.include_corrupted,
  });
  const measurementResult = await measureGemQuality(context, args.build_name, validation.needsQuality);
  const measurementMap = measurementResult.measurements;
  const needsQuality = [...validation.needsQuality].sort((a, b) => {
    const aMeasurement = measurementMap.get(gemLocationKey(a.location));
    const bMeasurement = measurementMap.get(gemLocationKey(b.location));
    const aScore = aMeasurement?.dpsScore;
    const bScore = bMeasurement?.dpsScore;
    if (aScore != null || bScore != null) {
      return (bScore ?? Number.NEGATIVE_INFINITY) - (aScore ?? Number.NEGATIVE_INFINITY);
    }
    return b.qualityGap - a.qualityGap;
  });

  // Format output
  const outputLines: string[] = [
    '=== Gem Quality Validation ===',
    '',
    `Mechanics freshness: ${GEM_MECHANICS_FRESHNESS_NOTE}`,
    '',
    measurementResult.note,
    '',
  ];

  if (needsQuality.length > 0) {
    outputLines.push(`⚠ ${needsQuality.length} gem(s) need quality improvement:`);
    for (let i = 0; i < needsQuality.length; i++) {
      const gem = needsQuality[i];
      const measurement = measurementMap.get(gemLocationKey(gem.location));
      outputLines.push(`${i + 1}. ${gem.gem}: ${gem.current} → ${gem.recommended}`);
      outputLines.push(`   Location: ${formatGemLocation(gem.location)}`);
      if (measurement && !measurement.error) {
        outputLines.push(`   Measured: yes - previewed Q${measurement.targetQuality}; restored=${measurement.restored ? 'yes' : 'no'}`);
        const deltaLines = measurementDeltaLines(measurement);
        if (deltaLines.length > 0) {
          outputLines.push('   Modeled stat delta:');
          for (const line of deltaLines) {
            outputLines.push(`     - ${line}`);
          }
          outputLines.push('   Priority basis: measured PoB stat delta; still verify price/acquisition before spending.');
        } else {
          outputLines.push(`   Modeled stat delta: none across tracked fields (${GEM_QUALITY_PREVIEW_FIELDS.join(', ')}).`);
          outputLines.push('   Priority basis: zero modeled delta; only consider QoL or untracked effects if the gem quality text matters.');
        }
      } else if (measurement?.error) {
        outputLines.push(`   Measured: no - preview failed (${measurement.error}); ${gem.measurement}`);
        outputLines.push(`   Priority basis: ${gem.qualityGap}% missing quality only; not a DPS ranking`);
      } else {
        outputLines.push(`   Measured: ${gem.measured ? "yes" : "no"} - ${gem.measurement}`);
        outputLines.push(`   Priority basis: ${gem.qualityGap}% missing quality only; not a DPS ranking`);
      }
    }
    outputLines.push('');
  } else {
    outputLines.push('✓ All gems have quality 20', '');
  }

  if (validation.qualityCapped.length > 0) {
    outputLines.push('Quality-capped gem copies:');
    for (let i = 0; i < validation.qualityCapped.length; i++) {
      const capped = validation.qualityCapped[i];
      outputLines.push(`${i + 1}. ${capped.gem}: ${capped.current}`);
      outputLines.push(`   Location: ${formatGemLocation(capped.location)}`);
      outputLines.push(`   Cap: ${capped.cap}`);
    }
    outputLines.push('');
  }

  if (validation.exceptionalUpgrades.length > 0) {
    outputLines.push('⭐ Exceptional Gem Upgrades Available:');
    for (let i = 0; i < validation.exceptionalUpgrades.length; i++) {
      const upgrade = validation.exceptionalUpgrades[i];
      outputLines.push(`${i + 1}. ${upgrade.gem} → ${upgrade.exceptional}`);
      outputLines.push(`   Location: ${formatGemLocation(upgrade.location)}`);
      outputLines.push(`   Est. DPS Gain: ${upgrade.dpsGain}`);
      outputLines.push(`   Acquirable: ${upgrade.acquirable}`);
      outputLines.push(`   Price-checked: ${upgrade.priceChecked ? "yes" : "no"}`);
    }
    outputLines.push('');
  }

  if (validation.corruptionTargets && validation.corruptionTargets.length > 0) {
    outputLines.push('💎 Corruption Opportunities:');
    for (let i = 0; i < validation.corruptionTargets.length; i++) {
      const target = validation.corruptionTargets[i];
      outputLines.push(`${i + 1}. ${target.gem} (current) → ${target.target} (corrupted)`);
      outputLines.push(`   Location: ${formatGemLocation(target.location)}`);
      outputLines.push(`   Cap: ${target.cap}`);
      outputLines.push(`   Risk: ${target.risk}`);
    }
    outputLines.push('');
  }

  if (needsQuality.length > 0) {
    const measured = needsQuality.find((gem) => measurementMap.get(gemLocationKey(gem.location))?.dpsScore != null);
    if (measured) {
      const measurement = measurementMap.get(gemLocationKey(measured.location));
      const delta = measurement?.dpsScore ?? 0;
      const sign = delta > 0 ? '+' : '';
      outputLines.push(`💡 Priority: ${measured.gem} has the highest measured DPS-field delta (${sign}${formatNumber(delta)}; ${formatGemLocation(measured.location)}).`);
    } else {
      const largestGap = needsQuality[0];
      outputLines.push(`💡 Priority: measure ${largestGap.gem} first (${largestGap.qualityGap}% quality gap; ${formatGemLocation(largestGap.location)}) before calling it a DPS upgrade`);
    }
  } else if (validation.exceptionalUpgrades.length > 0) {
    outputLines.push('💡 Consider Exceptional gem upgrades for significant DPS improvements');
  } else {
    outputLines.push('🎉 Your gems are fully optimized!');
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle find_optimal_links tool call
 */
export async function handleFindOptimalLinks(
  context: SkillGemHandlerContext,
  args: {
    build_name: string;
    skill_index?: number;
    skill_name?: string;
    link_count: number;
    budget?: "league_start" | "mid_league" | "endgame";
    optimize_for?: "dps" | "clear_speed" | "bossing" | "defense";
  }
) {
  const { buildService, skillGemService } = context;

  if (!args.build_name) {
    throw new Error("build_name is required");
  }

  if (!args.link_count || args.link_count < 4 || args.link_count > 6) {
    throw new Error("link_count must be between 4 and 6");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const selection = resolveSkillSelection(buildData, args);
  const skillIndex = selection.index;

  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);
  const suggestions = skillGemService.suggestSupportGems(buildData, skillIndex, {
    count: args.link_count - 1, // Subtract 1 for active skill
    includeExceptional: args.budget !== "league_start",
    budget: args.budget,
  });

  const budget = args.budget || "endgame";
  const optimizeFor = args.optimize_for || "dps";

  // Format output
  const outputLines: string[] = [
    `=== Optimal ${args.link_count}-Link for ${analysis.activeSkill.name} ===`,
    '',
    `Selected Skill: ${selection.skillName} (index ${skillIndex}; ${selection.reason})`,
    `Optimization Target: ${optimizeFor.toUpperCase()}`,
    `Budget: ${budget.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase())}`,
    '',
    '🏆 Optimal Setup:',
    `1. ${analysis.activeSkill.name} (${analysis.activeSkill.level}/${analysis.activeSkill.quality})`,
  ];

  for (let i = 0; i < Math.min(suggestions.length, args.link_count - 1); i++) {
    outputLines.push(`${i + 2}. ${suggestions[i].gem}`);
  }

  outputLines.push('', '=== Upgrade Path ===', '');

  let cumulativeDPS = 0;
  for (let i = 0; i < Math.min(suggestions.length, args.link_count - 1); i++) {
    const suggestion = suggestions[i];
    cumulativeDPS += suggestion.dpsIncrease;

    let stepLine = `Step ${i + 1}: Add ${suggestion.gem}`;
    if (suggestion.replaces) {
      stepLine += ` (replace ${suggestion.replaces})`;
    }
    outputLines.push(stepLine);
    outputLines.push(`Measured: ${suggestion.measured}`);
    outputLines.push(`Acquirable: ${suggestion.acquirable}`);
    outputLines.push(`Price-checked: ${suggestion.priceChecked ? "yes" : "no"}`);
    outputLines.push(`Price: ${suggestion.cost}`);
    outputLines.push(`Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    for (const note of suggestion.feasibilityNotes) {
      outputLines.push(`Note: ${note}`);
    }
    outputLines.push('');
  }

  outputLines.push('=== Summary ===');
  outputLines.push(`Total Heuristic DPS Increase: +${cumulativeDPS.toFixed(1)}%`);

  if (budget === "league_start") {
    outputLines.push('', '💡 League start setup focuses on easily obtainable gems');
  } else if (budget === "mid_league") {
    outputLines.push('', '💡 Mid-league setup balances cost and performance');
  } else {
    const bestSuggestion = suggestions[0];
    if (bestSuggestion) {
      outputLines.push('', `💡 Best first upgrade: ${bestSuggestion.gem} (+${bestSuggestion.dpsIncrease.toFixed(1)}%)`);
    }
  }
  const output = outputLines.join('\n');

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

/**
 * Handle gem_upgrade_path tool call
 */
export async function handleGemUpgradePath(
  context: SkillGemHandlerContext,
  args: { build_name?: string; budget?: string }
) {
  if (!context.ensureLuaClient || !context.getLuaClient) {
    throw new Error('Lua bridge not configured. Use lua_load_build first.');
  }
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const skills = await luaClient.getSkills();
  const groups: any[] = skills?.groups ?? [];

  const budgetTier = ((args.budget || 'endgame') as 'league_start' | 'mid_league' | 'endgame');
  const budgetMap: Record<string, number> = { league_start: 0, mid_league: 50, endgame: 999 };
  const budgetChaos = budgetMap[budgetTier] ?? 999;

  interface GemUpgrade {
    gemName: string;
    groupLabel: string;
    currentLevel: number;
    currentQuality: number;
    action: string;
    priority: number;
    priceStatus: string;
    measured: string;
    acquirable: string;
    priceChecked: boolean;
    reason: string;
  }

  const upgrades: GemUpgrade[] = [];

  for (const group of groups) {
    const isMain = group.index === skills.mainSocketGroup;
    for (const gem of (group.gems ?? [])) {
      const name: string = gem.name || gem;
      const level: number = gem.level ?? 1;
      const quality: number = gem.quality ?? 0;
      const isSupport = name.includes('Support') || name.includes('Mirage') || gem.isSupport;
      const multiplier = isMain ? 3 : 1;

      // Level upgrade
      if (level < 20) {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: `Level to 20 (currently ${level})`,
          priority: (20 - level) * multiplier * (isSupport ? 0.8 : 1.2),
          priceStatus: 'self-progression; no market price checked',
          measured: 'heuristic priority only (not live PoB DPS)',
          acquirable: 'self-leveling available if the gem can gain experience',
          priceChecked: false,
          reason: 'Every gem level increases gem power — level gems in inactive weapon swap slots',
        });
      }

      // Quality upgrade
      if (quality < 20) {
        const costChaos = Math.round((20 - quality) * 0.2);
        if (costChaos <= budgetChaos) {
          upgrades.push({
            gemName: name,
            groupLabel: group.label || `Group ${group.index}`,
            currentLevel: level,
            currentQuality: quality,
            action: `Bring to 20% quality (currently ${quality}%)`,
            priority: (20 - quality) * multiplier * (isSupport ? 0.6 : 0.9),
            priceStatus: "not price-checked; verify current Gemcutter's Prism prices",
            measured: 'heuristic priority only (not live PoB DPS)',
            acquirable: 'currency action, not a guaranteed market purchase',
            priceChecked: false,
            reason: 'Quality bonuses vary by gem and patch — apply quality, then verify the current PoB readback/stat delta',
          });
        }
      }

      // 21/20 via corruption
      if (level === 20 && quality === 20 && isMain) {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: 'Corrupt for 21/20 (Vaal Orb on 20/20)',
          priority: 15 * multiplier,
          priceStatus: 'not price-checked; corruption can add at most +1 level or +3 quality',
          measured: 'heuristic priority only (not live PoB DPS)',
          acquirable: 'corruption outcome, not guaranteed',
          priceChecked: false,
          reason: 'Level 21 can be valuable for active gems; verify current price before buying a corrupted gem',
        });
      }

      // Exceptional version for supports
      if (isSupport && isMain && level >= 18 && budgetTier === 'endgame') {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: `Check Exceptional ${name.replace(' Support', '')} Support`,
          priority: 20,
          priceStatus: 'not price-checked; verify current league trade availability before buying',
          measured: 'heuristic priority only (not live PoB DPS)',
          acquirable: 'unverified in requested league',
          priceChecked: false,
          reason: 'Exceptional support availability is version-sensitive; PoB calc support is not proof of acquisition',
        });
      }
    }
  }

  upgrades.sort((a, b) => b.priority - a.priority);

  const outputLines: string[] = [
    '=== Gem Upgrade Path ===',
    `Budget tier: ${budgetTier}`,
    '',
    `Mechanics freshness: ${GEM_MECHANICS_FRESHNESS_NOTE}`,
    '',
  ];

  if (upgrades.length === 0) {
    outputLines.push('All gems appear to be fully upgraded!');
    return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
  }

  let rank = 1;
  for (const u of upgrades.slice(0, 15)) {
    outputLines.push(`**${rank}. ${u.gemName}** (${u.groupLabel})`);
    outputLines.push(`   Action: ${u.action}`);
    outputLines.push(`   Measured: ${u.measured}`);
    outputLines.push(`   Acquirable: ${u.acquirable}`);
    outputLines.push(`   Price-checked: ${u.priceChecked ? "yes" : "no"}`);
    outputLines.push(`   Price/availability: ${u.priceStatus}`);
    outputLines.push(`   Why: ${u.reason}`);
    outputLines.push('');
    rank++;
  }

  outputLines.push('_Use `validate_gem_quality` for a full gem quality audit._');

  return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}

/**
 * Helper: Extract skills from build
 */
function extractSkills(build: any): ExtractedSkillGroup[] {
  const skills: ExtractedSkillGroup[] = [];

  if (build.Skills?.SkillSet) {
    const skillSets = Array.isArray(build.Skills.SkillSet)
      ? build.Skills.SkillSet
      : [build.Skills.SkillSet];
    const activeSkillSetId = String(build.Skills.activeSkillSet ?? skillSets[0]?.id ?? "1");

    for (let skillSetIndex = 0; skillSetIndex < skillSets.length; skillSetIndex++) {
      const skillSet = skillSets[skillSetIndex];
      const skillSetId = String(skillSet.id ?? skillSetIndex + 1);
      const isInActiveSet = skillSetId === activeSkillSetId;
      if (skillSet.Skill) {
        const skillArray = Array.isArray(skillSet.Skill) ? skillSet.Skill : [skillSet.Skill];

        for (const skill of skillArray) {
          if (skill.Gem) {
            const gems = Array.isArray(skill.Gem) ? skill.Gem : [skill.Gem];
            skills.push({
              index: skills.length,
              gems,
              slot: skill.slot || "Unknown",
              activeSkillName: gemName(gems[0]),
              isMain: isInActiveSet && isTruthy(skill.mainActiveSkill),
              isEnabled: !isFalsey(skill.enabled),
              isInActiveSet,
            });
          }
        }
      }
    }
  }

  return skills;
}
