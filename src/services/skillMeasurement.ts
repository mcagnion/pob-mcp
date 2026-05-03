/**
 * Shared skill-measurement primitives for the Lua-bridge gem-disable workflow.
 *
 * Lives outside the handlers tree to break the circular import that existed
 * when skillGemHandlers and advancedOptimizationHandlers each depended on
 * helpers exported by the other. Both handler modules now import everything
 * measurement-related from here.
 */

import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import type { MeasuredGemEntry, MeasuredSkillContext } from "../skillLinkOptimizer.js";

export const GEM_CONTRIBUTION_PREVIEW_FIELDS = [
  'FullDPS',
  'FullDotDPS',
  'TotalDPS',
  'CombinedDPS',
  'TotalDotDPS',
  'Speed',
  'ManaCost',
];

export const GEM_CONTRIBUTION_DPS_PRIORITY_FIELDS = [
  'FullDPS',
  'TotalDPS',
  'CombinedDPS',
  'FullDotDPS',
  'TotalDotDPS',
];

export const LINK_MEASUREMENT_GUARDRAIL =
  'Guardrail: before replacing supports, run measure_link_contributions on the loaded build; estimates here are structural and not a measured DPS ranking.';

export const MEASURED_LINK_NOTICE =
  'Measured link contributions were folded into this analysis; static "no more multipliers" warnings have been downgraded where measurement contradicts.';

export const MEASURED_LINK_PARTIAL_NOTICE =
  'Measured link contributions were partial: at least one gem failed to measure or the measurement loop aborted on a restore failure. Treat the measured signals below as incomplete and rerun measure_link_contributions before replacing supports.';

export const MULTIPLIER_EQUIVALENT_THRESHOLD_PERCENT = 10;

export interface GemIdentity {
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

export interface GemContributionMeasurement extends GemIdentity {
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

export function numericStat(stats: Record<string, any> | undefined, field: string): number | null {
  if (!stats || stats[field] == null) return null;
  const value = Number(stats[field]);
  return Number.isFinite(value) ? value : null;
}

export function primaryContribution(
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

export function groupGemList(group: any): any[] {
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

export function gemIdentity(group: any, gem: any, fallbackIndex: number): GemIdentity {
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

export function findSkillGroup(skills: any, groupIndex?: number): any | null {
  const groups = Array.isArray(skills?.groups) ? skills.groups : [];
  if (groups.length === 0) return null;
  const targetIndex = groupIndex ?? Number(skills?.mainSocketGroup ?? groups[0]?.index);
  return groups.find((group: any) => Number(group?.index) === targetIndex) ?? null;
}

export async function measureGemDisable(
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

export async function buildMeasuredSkillContext(
  luaClient: PoBLuaApiClient | null,
  buildName: string | undefined,
  groupIndex?: number,
): Promise<{ context?: MeasuredSkillContext; reason?: string }> {
  if (!luaClient || !luaClient.isAlive()) {
    return { reason: 'Lua bridge unavailable' };
  }
  let info: any;
  try {
    info = await luaClient.getBuildInfo();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { reason: `could not read loaded build info (${msg})` };
  }
  if (buildName) {
    const loaded = String(info?.name ?? '').replace(/\.xml$/i, '').trim().toLowerCase();
    const requested = buildName.replace(/\.xml$/i, '').trim().toLowerCase();
    if (loaded && requested && loaded !== requested) {
      return { reason: `Lua bridge has "${info?.name ?? loaded}" loaded, not "${buildName}"` };
    }
  }

  let skills: any;
  try {
    skills = await luaClient.getSkills();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { reason: `could not read loaded skill gems (${msg})` };
  }

  const group = findSkillGroup(skills, groupIndex);
  if (!group) {
    return { reason: groupIndex ? `socket group ${groupIndex} not found` : 'main socket group not found' };
  }

  const gems = groupGemList(group);
  const entries: MeasuredGemEntry[] = [];
  let primaryField: string | undefined;
  let partial = false;

  for (let index = 0; index < gems.length; index++) {
    const identity = gemIdentity(group, gems[index], index + 1);
    const measurement = await measureGemDisable(luaClient, identity);

    if (measurement.alreadyDisabled) {
      entries.push({
        gemIndex: identity.gemIndex,
        name: identity.name,
        isSupport: identity.isSupport,
        primaryField: undefined,
        contributionPercent: 0,
        alreadyDisabled: true,
        failed: false,
      });
      continue;
    }
    if (measurement.error) {
      entries.push({
        gemIndex: identity.gemIndex,
        name: identity.name,
        isSupport: identity.isSupport,
        primaryField: undefined,
        contributionPercent: null,
        alreadyDisabled: false,
        failed: true,
        failureReason: measurement.error,
      });
      partial = true;
      // A non-restored failure means subsequent measurements are unreliable; bail.
      if (/restore/i.test(measurement.error)) {
        // Mark every remaining gem as un-measured so callers can see the loop aborted.
        for (let remaining = index + 1; remaining < gems.length; remaining++) {
          const skipped = gemIdentity(group, gems[remaining], remaining + 1);
          entries.push({
            gemIndex: skipped.gemIndex,
            name: skipped.name,
            isSupport: skipped.isSupport,
            primaryField: undefined,
            contributionPercent: null,
            alreadyDisabled: false,
            failed: true,
            failureReason: 'skipped after prior restore failure',
          });
        }
        break;
      }
      continue;
    }

    if (!primaryField && measurement.primaryField) primaryField = measurement.primaryField;

    entries.push({
      gemIndex: identity.gemIndex,
      name: identity.name,
      isSupport: identity.isSupport,
      primaryField: measurement.primaryField,
      contributionPercent: measurement.contributionPercent,
      alreadyDisabled: false,
      failed: false,
    });
  }

  return {
    context: {
      groupIndex: Number(group?.index),
      primaryField,
      multiplierEquivalentThresholdPercent: MULTIPLIER_EQUIVALENT_THRESHOLD_PERCENT,
      entries,
      partial,
    },
  };
}
