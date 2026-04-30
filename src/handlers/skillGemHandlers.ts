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

const GEM_CONTRIBUTION_PREVIEW_FIELDS = GEM_QUALITY_PREVIEW_FIELDS;
const GEM_CONTRIBUTION_DPS_PRIORITY_FIELDS = GEM_QUALITY_DPS_PRIORITY_FIELDS;
const GEM_CONTRIBUTION_WARNING =
  'Measured contribution is marginal at the current configuration; values are not additive across multiple gem changes.';
const LINK_MEASUREMENT_GUARDRAIL =
  'Guardrail: before replacing supports, run measure_link_contributions on the loaded build; estimates here are structural and not a measured DPS ranking.';

interface GemQualityMeasurement {
  restored: boolean;
  before: Record<string, any>;
  after: Record<string, any>;
  restoredStats?: Record<string, any>;
  targetQuality: number;
  dpsScore: number | null;
  error?: string;
}

interface GemIdentity {
  groupIndex: number;
  groupLabel: string;
  slot: string;
  gemIndex: number;
  name: string;
  level?: number;
  quality?: number;
  enabled: boolean;
  isSupport: boolean;
}

interface GemContributionMeasurement extends GemIdentity {
  restored: boolean;
  before: Record<string, any>;
  after: Record<string, any>;
  restoredStats?: Record<string, any>;
  primaryField?: string;
  primaryBefore?: number;
  primaryAfter?: number;
  contribution: number | null;
  contributionPercent: number | null;
  alreadyDisabled: boolean;
  error?: string;
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

function statSnapshotLine(label: string, stats: Record<string, any> | undefined): string {
  const entries = GEM_CONTRIBUTION_PREVIEW_FIELDS
    .map((field) => {
      const value = numericStat(stats, field);
      return value == null ? null : `${field}=${formatNumber(value)}`;
    })
    .filter((entry): entry is string => entry !== null);
  return `${label}: ${entries.length > 0 ? entries.join(', ') : 'no tracked fields returned'}`;
}

function contributionDeltaLines(measurement: GemContributionMeasurement): string[] {
  const changedLines: string[] = [];
  for (const field of GEM_CONTRIBUTION_PREVIEW_FIELDS) {
    const before = numericStat(measurement.before, field);
    const after = numericStat(measurement.after, field);
    if (before == null || after == null) continue;
    if (before !== after) {
      changedLines.push(formatMeasuredDelta(field, before, after));
    }
  }
  return changedLines;
}

function primaryContribution(
  beforeStats: Record<string, any>,
  afterStats: Record<string, any>
): { field: string; before: number; after: number; loss: number; percent: number | null } | null {
  for (const field of GEM_CONTRIBUTION_DPS_PRIORITY_FIELDS) {
    const before = numericStat(beforeStats, field);
    const after = numericStat(afterStats, field);
    if (before != null && after != null) {
      const loss = before - after;
      return {
        field,
        before,
        after,
        loss,
        percent: before !== 0 ? (loss / before) * 100 : null,
      };
    }
  }
  return null;
}

function groupGemList(group: any): any[] {
  if (Array.isArray(group?.gems) && group.gems.length > 0) {
    return group.gems;
  }
  if (Array.isArray(group?.skills)) {
    return group.skills.map((skillName: string, index: number) => ({
      index: index + 1,
      name: skillName,
      enabled: true,
      isSupport: index > 0,
    }));
  }
  return [];
}

function gemIdentity(group: any, gem: any, fallbackIndex: number): GemIdentity {
  const gemIndex = Number(gem?.index ?? fallbackIndex);
  return {
    groupIndex: Number(group?.index),
    groupLabel: group?.label || `Group ${group?.index ?? '?'}`,
    slot: group?.slot || 'Unknown',
    gemIndex,
    name: gem?.name || gem?.nameSpec || `Gem ${gemIndex}`,
    level: typeof gem?.level === 'number' ? gem.level : undefined,
    quality: typeof gem?.quality === 'number' ? gem.quality : undefined,
    enabled: gem?.enabled !== false,
    isSupport: gem?.isSupport === true || (typeof gem?.name === 'string' && gem.name.includes('Support')),
  };
}

function findSkillGroup(skills: any, groupIndex?: number): any | null {
  const groups = Array.isArray(skills?.groups) ? skills.groups : [];
  if (groups.length === 0) return null;
  const targetIndex = groupIndex ?? Number(skills?.mainSocketGroup ?? groups[0]?.index);
  return groups.find((group: any) => Number(group?.index) === targetIndex) ?? null;
}

function findGemInGroup(group: any, gemIndex: number): { gem: any; fallbackIndex: number } | null {
  const gems = groupGemList(group);
  for (let index = 0; index < gems.length; index++) {
    const gem = gems[index];
    const candidateIndex = Number(gem?.index ?? index + 1);
    if (candidateIndex === gemIndex) {
      return { gem, fallbackIndex: index + 1 };
    }
  }
  return null;
}

async function getLiveGemContext(
  context: SkillGemHandlerContext,
  buildName: string | undefined,
  rerunToolName: string
): Promise<
  | { ok: true; luaClient: PoBLuaApiClient; skills: any; loadedName: string }
  | { ok: false; message: string }
> {
  const luaClient = context.getLuaClient?.() ?? null;
  if (!luaClient || !luaClient.isAlive()) {
    return {
      ok: false,
      message: `Measurement unavailable: Lua bridge is not active. Use lua_load_build for the build, then rerun ${rerunToolName}. No ranking produced.`,
    };
  }

  let info: any;
  try {
    info = await luaClient.getBuildInfo();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Measurement unavailable: could not read loaded build info (${msg}). Use lua_load_build first, then rerun ${rerunToolName}. No ranking produced.`,
    };
  }

  const loadedNameRaw = info?.name ?? info?.buildName ?? '';
  const loadedName = loadedNameRaw ? String(loadedNameRaw) : 'current loaded build';
  if (buildName) {
    const loadedNormalized = normalizeBuildName(loadedName);
    const requestedNormalized = normalizeBuildName(buildName);
    if (loadedNormalized && requestedNormalized && loadedNormalized !== requestedNormalized) {
      return {
        ok: false,
        message: `Measurement unavailable: Lua bridge has "${loadedName}" loaded, not "${buildName}". Use lua_load_build("${buildName}") first. No ranking produced.`,
      };
    }
  }

  try {
    const skills = await luaClient.getSkills();
    return { ok: true, luaClient, skills, loadedName };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Measurement unavailable: could not read loaded skill gems (${msg}). No ranking produced.`,
    };
  }
}

async function measureGemDisable(
  luaClient: PoBLuaApiClient,
  identity: GemIdentity
): Promise<GemContributionMeasurement> {
  if (!identity.enabled) {
    return {
      ...identity,
      restored: true,
      before: {},
      after: {},
      contribution: 0,
      contributionPercent: 0,
      alreadyDisabled: true,
    };
  }

  try {
    const preview = await luaClient.previewGemEnabled({
      groupIndex: identity.groupIndex,
      gemIndex: identity.gemIndex,
      enabled: false,
      fields: GEM_CONTRIBUTION_PREVIEW_FIELDS,
    });
    if (preview.restored !== true) {
      throw new Error('preview did not restore original gem state');
    }
    const primary = primaryContribution(preview.before ?? {}, preview.after ?? {});
    return {
      ...identity,
      restored: preview.restored === true,
      before: preview.before ?? {},
      after: preview.after ?? {},
      restoredStats: preview.restoredStats,
      primaryField: primary?.field,
      primaryBefore: primary?.before,
      primaryAfter: primary?.after,
      contribution: primary?.loss ?? null,
      contributionPercent: primary?.percent ?? null,
      alreadyDisabled: false,
    };
  } catch (error) {
    return {
      ...identity,
      restored: false,
      before: {},
      after: {},
      contribution: null,
      contributionPercent: null,
      alreadyDisabled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendContributionDetails(outputLines: string[], measurement: GemContributionMeasurement): void {
  outputLines.push(`${measurement.name} (${measurement.isSupport ? 'support' : 'active'} gem)`);
  outputLines.push(`Location: group_index=${measurement.groupIndex}, gem_index=${measurement.gemIndex}, slot=${measurement.slot}, group=${measurement.groupLabel}`);

  if (measurement.alreadyDisabled) {
    outputLines.push('current_contribution: 0 (gem already disabled in this configuration)');
    return;
  }

  if (measurement.error) {
    outputLines.push(`Measurement failed: ${measurement.error}`);
    return;
  }

  outputLines.push(`Restored: ${measurement.restored ? 'yes' : 'no'}`);
  outputLines.push(statSnapshotLine('Before', measurement.before));
  outputLines.push(statSnapshotLine('After disabling', measurement.after));

  if (measurement.primaryField && measurement.primaryBefore != null && measurement.primaryAfter != null && measurement.contribution != null) {
    const percent = measurement.contributionPercent != null
      ? ` (${formatNumber(measurement.contributionPercent)}% of current)`
      : '';
    outputLines.push(`Primary DPS-field loss: ${formatMeasuredDelta(measurement.primaryField, measurement.primaryBefore, measurement.primaryAfter)}`);
    outputLines.push(`current_contribution: ${formatNumber(measurement.contribution)} ${measurement.primaryField}${percent}`);
  } else {
    outputLines.push(`current_contribution: no modeled DPS-field loss across tracked fields (${GEM_CONTRIBUTION_PREVIEW_FIELDS.join(', ')})`);
  }

  const deltaLines = contributionDeltaLines(measurement);
  if (deltaLines.length > 0) {
    outputLines.push('Tracked stat deltas:');
    for (const line of deltaLines) {
      outputLines.push(`- ${line}`);
    }
  }
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
  args?: { build_name?: string; skill_index?: number }
) {
  return wrapHandler('analyze skill links', async () => {
  const { buildService, skillGemService } = context;

  if (!args?.build_name) {
    throw new Error("build_name is required");
  }

  const buildData = await buildService.readBuild(args.build_name);
  const skillIndex = args.skill_index || 0;

  const analysis = skillGemService.analyzeSkillLinks(buildData, skillIndex);

  // Format output
  const outputLines: string[] = [
    `=== Skill Analysis: ${analysis.activeSkill.name} ===`,
    '',
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
  const skillIndex = args.skill_index || 0;

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
    LINK_MEASUREMENT_GUARDRAIL,
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

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];

    outputLines.push(`${i + 1}. ${suggestion.gem}`);
    if (suggestion.replaces) {
      outputLines.push(`   Replaces: ${suggestion.replaces}`);
    }
    outputLines.push(`   Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    outputLines.push(`   Why: ${suggestion.reasoning}`);
    outputLines.push(`   Cost: ${suggestion.cost}`);

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
  const skills = extractSkills(buildData);
  const skillIndex = args.skill_index || 0;
  const activeSkillName = skills[skillIndex]?.gems[0]?.nameSpec || "Unknown Skill";

  const outputLines: string[] = [
    `=== Gem Setup Comparison for ${activeSkillName} ===`,
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
  const outputLines: string[] = ['=== Gem Quality Validation ===', '', measurementResult.note, ''];

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
      outputLines.push(`   Est. DPS Gain: ${upgrade.dpsGain}`);
    }
    outputLines.push('');
  }

  if (validation.corruptionTargets && validation.corruptionTargets.length > 0) {
    outputLines.push('💎 Corruption Opportunities:');
    for (let i = 0; i < validation.corruptionTargets.length; i++) {
      const target = validation.corruptionTargets[i];
      outputLines.push(`${i + 1}. ${target.gem} (current) → ${target.target} (corrupted)`);
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
 * Handle measure_gem_contribution tool call
 */
export async function handleMeasureGemContribution(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; group_index?: number; gem_index?: number }
) {
  return wrapHandler('measure gem contribution', async () => {
    if (!args?.group_index || args.group_index < 1) {
      throw new Error('group_index must be >= 1');
    }
    if (!args?.gem_index || args.gem_index < 1) {
      throw new Error('gem_index must be >= 1');
    }

    const live = await getLiveGemContext(context, args.build_name, 'measure_gem_contribution');
    if (!live.ok) {
      return { content: [{ type: 'text' as const, text: `=== Gem Contribution Measurement ===\n\n${live.message}` }] };
    }

    const group = findSkillGroup(live.skills, args.group_index);
    if (!group) {
      throw new Error(`socket group ${args.group_index} not found in loaded build`);
    }
    const gemMatch = findGemInGroup(group, args.gem_index);
    if (!gemMatch) {
      throw new Error(`gem ${args.gem_index} not found in socket group ${args.group_index}`);
    }

    const identity = gemIdentity(group, gemMatch.gem, gemMatch.fallbackIndex);
    const measurement = await measureGemDisable(live.luaClient, identity);
    const outputLines = [
      '=== Gem Contribution Measurement ===',
      '',
      args.build_name
        ? `Build context: requested "${args.build_name}" matches loaded build "${live.loadedName}".`
        : `Build context: measuring currently loaded build "${live.loadedName}".`,
      GEM_CONTRIBUTION_WARNING,
      '',
    ];

    appendContributionDetails(outputLines, measurement);

    return {
      content: [{ type: 'text' as const, text: outputLines.join('\n') }],
    };
  });
}

/**
 * Handle measure_link_contributions tool call
 */
export async function handleMeasureLinkContributions(
  context: SkillGemHandlerContext,
  args?: { build_name?: string; group_index?: number }
) {
  return wrapHandler('measure link contributions', async () => {
    if (args?.group_index != null && args.group_index < 1) {
      throw new Error('group_index must be >= 1');
    }

    const live = await getLiveGemContext(context, args?.build_name, 'measure_link_contributions');
    if (!live.ok) {
      return { content: [{ type: 'text' as const, text: `=== Link Contribution Measurement ===\n\n${live.message}` }] };
    }

    const group = findSkillGroup(live.skills, args?.group_index);
    if (!group) {
      throw new Error(args?.group_index ? `socket group ${args.group_index} not found in loaded build` : 'main socket group not found in loaded build');
    }

    const gems = groupGemList(group);
    const measurements: GemContributionMeasurement[] = [];
    for (let index = 0; index < gems.length; index++) {
      const identity = gemIdentity(group, gems[index], index + 1);
      const measurement = await measureGemDisable(live.luaClient, identity);
      measurements.push(measurement);
      if (measurement.error && /restore/i.test(measurement.error)) {
        break;
      }
    }

    const measured = measurements
      .filter((measurement) => !measurement.alreadyDisabled && !measurement.error)
      .sort((a, b) => (b.contribution ?? Number.NEGATIVE_INFINITY) - (a.contribution ?? Number.NEGATIVE_INFINITY));
    const alreadyDisabled = measurements.filter((measurement) => measurement.alreadyDisabled);
    const failed = measurements.filter((measurement) => measurement.error);

    const outputLines = [
      '=== Link Contribution Measurement ===',
      '',
      args?.build_name
        ? `Build context: requested "${args.build_name}" matches loaded build "${live.loadedName}".`
        : `Build context: measuring currently loaded build "${live.loadedName}".`,
      `Group: ${group?.label || `Group ${group?.index}`} (group_index=${group?.index}, slot=${group?.slot || 'Unknown'})`,
      GEM_CONTRIBUTION_WARNING,
      '',
    ];

    if (measured.length > 0) {
      outputLines.push('Measured current contributions, sorted by primary DPS-field loss:');
      for (let index = 0; index < measured.length; index++) {
        const measurement = measured[index];
        outputLines.push('');
        outputLines.push(`${index + 1}.`);
        appendContributionDetails(outputLines, measurement);
      }
    } else {
      outputLines.push('No enabled gems produced a measured DPS-field contribution.');
    }

    if (alreadyDisabled.length > 0) {
      outputLines.push('', 'Already disabled gems:');
      for (const measurement of alreadyDisabled) {
        outputLines.push(`- ${measurement.name} (group_index=${measurement.groupIndex}, gem_index=${measurement.gemIndex})`);
        outputLines.push('  current_contribution: 0 (gem already disabled in this configuration)');
      }
    }

    if (failed.length > 0) {
      outputLines.push('', 'Failed measurements:');
      for (const measurement of failed) {
        outputLines.push(`- ${measurement.name} (group_index=${measurement.groupIndex}, gem_index=${measurement.gemIndex}): ${measurement.error}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: outputLines.join('\n') }],
    };
  });
}

/**
 * Handle find_optimal_links tool call
 */
export async function handleFindOptimalLinks(
  context: SkillGemHandlerContext,
  args: {
    build_name: string;
    skill_index?: number;
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
  const skillIndex = args.skill_index || 0;

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
    outputLines.push(`Cost: ${suggestion.cost}`);
    outputLines.push(`Est. DPS Increase: +${suggestion.dpsIncrease.toFixed(1)}%`);
    outputLines.push('');
  }

  outputLines.push('=== Summary ===');
  outputLines.push(`Total Est. DPS Increase: +${cumulativeDPS.toFixed(1)}%`);

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
    costEstimate: string;
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
          costEstimate: 'Free (just level it)',
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
            costEstimate: `~${costChaos}c in Gemcutter's Prisms`,
            reason: 'Quality bonuses stack with gem level — use Hillock crafting bench for +28% quality',
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
          costEstimate: '25% chance of 21/20, 25% chance brick — buy pre-corrupted 21/20 for safety',
          reason: 'Level 21 is a significant DPS increase for active gems; corruption is high-risk/reward',
        });
      }

      // Exceptional version for supports
      if (isSupport && isMain && level >= 18 && budgetTier === 'endgame') {
        upgrades.push({
          gemName: name,
          groupLabel: group.label || `Group ${group.index}`,
          currentLevel: level,
          currentQuality: quality,
          action: `Buy Exceptional ${name.replace(' Support', '')} Support`,
          priority: 20,
          costEstimate: 'Varies greatly — check poe.ninja prices',
          reason: 'Exceptional supports have higher quality bonuses and occasionally better base effects',
        });
      }
    }
  }

  upgrades.sort((a, b) => b.priority - a.priority);

  const outputLines: string[] = ['=== Gem Upgrade Path ===', `Budget tier: ${budgetTier}`, ''];

  if (upgrades.length === 0) {
    outputLines.push('All gems appear to be fully upgraded!');
    return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
  }

  let rank = 1;
  for (const u of upgrades.slice(0, 15)) {
    outputLines.push(`**${rank}. ${u.gemName}** (${u.groupLabel})`);
    outputLines.push(`   Action: ${u.action}`);
    outputLines.push(`   Cost: ${u.costEstimate}`);
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
function extractSkills(build: any): Array<{ gems: any[]; slot: string }> {
  const skills: Array<{ gems: any[]; slot: string }> = [];

  if (build.Skills?.SkillSet) {
    const skillSets = Array.isArray(build.Skills.SkillSet)
      ? build.Skills.SkillSet
      : [build.Skills.SkillSet];

    for (const skillSet of skillSets) {
      if (skillSet.Skill) {
        const skillArray = Array.isArray(skillSet.Skill) ? skillSet.Skill : [skillSet.Skill];

        for (const skill of skillArray) {
          if (skill.Gem) {
            const gems = Array.isArray(skill.Gem) ? skill.Gem : [skill.Gem];
            skills.push({
              gems,
              slot: skill.slot || "Unknown",
            });
          }
        }
      }
    }
  }

  return skills;
}
