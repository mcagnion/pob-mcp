import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import {
  CONFIG_ASSUMPTION_PROFILES,
  CONFIG_ASSUMPTION_PROFILE_VALUES,
  type AssumptionCategory,
  type AssumptionSeverity,
  type ConfigAssumptionProfile,
  isConfigAssumptionProfile,
} from "../data/configAssumptionProfiles.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface ConfigAssumptionHandlerContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type DataKind = "direct_from_pob" | "direct_from_pob_config" | "derived_from_pob" | "heuristic" | "unknown";
type Classification =
  | "always_on"
  | "usually_mapping"
  | "usually_bossing"
  | "conditional"
  | "burst_only"
  | "flask_dependent"
  | "guard_skill_dependent"
  | "on_kill_only"
  | "needs_verification"
  | "unknown";
type Confidence = "high" | "medium" | "low";

interface AssumptionFinding {
  id: string;
  name: string;
  state: string;
  classification: Classification;
  severity: AssumptionSeverity;
  confidence: Confidence;
  data_kind: DataKind;
  evidence: string[];
  impact: string;
  suggested_next_test: string;
}

interface UnknownFinding {
  id: string;
  name: string;
  reason: string;
}

interface DataResult<T> {
  value: T | null;
  error?: string;
}

const CHARGE_CONFIGS = [
  { key: "usePowerCharges", label: "Power charges", required: true },
  { key: "useFrenzyCharges", label: "Frenzy charges", required: true },
  { key: "useEnduranceCharges", label: "Endurance charges", required: true },
  { key: "useSiphoningCharges", label: "Siphoning charges", required: false },
] as const;

const GUARD_SKILLS = [
  "Molten Shell",
  "Steelskin",
  "Immortal Call",
  "Arcane Cloak",
];

const GUARD_BUFF_KEYS = new Set(["buffFortify", "buffFortification"]);

const DEFAULT_ENEMY_CONFIG: Record<string, unknown> = {
  enemyLevel: 84,
  enemyFireResist: 40,
  enemyColdResist: 40,
  enemyLightningResist: 40,
  enemyChaosResist: 20,
  enemyArmour: 0,
  enemyEvasion: 0,
};

export async function handleAnalyzeConfigAssumptions(
  context: ConfigAssumptionHandlerContext,
  args: { profile?: unknown } = {}
) {
  return wrapHandler("analyze config assumptions", async () => {
    const profile = parseProfile(args.profile);
    const data = await collectReadOnlyData(context);
    const analysis = buildConfigAssumptionAnalysis(profile, data);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  });
}

function parseProfile(profile: unknown): ConfigAssumptionProfile {
  const value = profile ?? "sc_trade_mapping";
  if (isConfigAssumptionProfile(value)) return value;
  throw new Error(`Unsupported profile "${String(value)}". Supported profiles: ${CONFIG_ASSUMPTION_PROFILE_VALUES.join(", ")}`);
}

async function collectReadOnlyData(context: ConfigAssumptionHandlerContext) {
  let ensureError: string | undefined;
  try {
    await context.ensureLuaClient();
  } catch (error) {
    ensureError = formatError(error);
  }

  const luaClient = context.getLuaClient();
  if (!luaClient) {
    return {
      ensureError,
      config: { value: null, error: ensureError || "Lua client is not available." } as DataResult<Record<string, unknown>>,
      items: { value: null, error: "Lua client is not available." } as DataResult<any[]>,
      skills: { value: null, error: "Lua client is not available." } as DataResult<any>,
      buildInfo: { value: null, error: "Lua client is not available." } as DataResult<any>,
    };
  }

  return {
    ensureError,
    config: await readData(() => luaClient.getConfig()),
    items: await readData(() => luaClient.getItems()),
    skills: await readData(() => luaClient.getSkills()),
    buildInfo: await readData(() => luaClient.getBuildInfo()),
  };
}

async function readData<T>(reader: () => Promise<T>): Promise<DataResult<T>> {
  try {
    const value = await reader();
    return { value: value ?? null };
  } catch (error) {
    return { value: null, error: formatError(error) };
  }
}

function buildConfigAssumptionAnalysis(profile: ConfigAssumptionProfile, data: Awaited<ReturnType<typeof collectReadOnlyData>>) {
  const assumptions: AssumptionFinding[] = [];
  const unknowns: UnknownFinding[] = [];
  const profileDef = CONFIG_ASSUMPTION_PROFILES[profile];
  const severityFor = (category: AssumptionCategory) => profileDef.severityByCategory[category];
  const config = isObject(data.config.value) ? data.config.value : null;

  if (!config) {
    unknowns.push({
      id: "config.unavailable",
      name: "PoB configuration",
      reason: data.config.error || "getConfig returned no configuration data.",
    });
  } else {
    appendChargeFindings(assumptions, unknowns, config, severityFor);
    appendConditionFindings(assumptions, config, severityFor);
    appendBuffFindings(assumptions, config, severityFor);
    appendEnemySettingFindings(assumptions, config, severityFor);
    appendMultiplierFindings(assumptions, config, severityFor);
    appendCustomModFindings(assumptions, config, severityFor);
  }

  appendFlaskFindings(assumptions, unknowns, data.items, severityFor);
  appendSkillFindings(assumptions, unknowns, data.skills, severityFor);

  const buildInfo = isObject(data.buildInfo.value) ? data.buildInfo.value : {};
  if (!data.buildInfo.value && data.buildInfo.error) {
    unknowns.push({
      id: "build.info.unavailable",
      name: "Build metadata",
      reason: data.buildInfo.error,
    });
  }

  const summary = summarize(assumptions, unknowns);

  return {
    schema_version: "0.1",
    tool: "analyze_config_assumptions",
    profile,
    profile_context: {
      label: profileDef.label,
      primary_concern: profileDef.primaryConcern,
    },
    build: {
      name: stringOrNull(buildInfo.name ?? buildInfo.buildName ?? buildInfo.title),
      pob_version: stringOrNull(buildInfo.pobVersion ?? buildInfo.version),
    },
    summary,
    assumptions,
    unknowns,
  };
}

function appendChargeFindings(
  assumptions: AssumptionFinding[],
  unknowns: UnknownFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  for (const { key, label, required } of CHARGE_CONFIGS) {
    if (!(key in config)) {
      if (required) {
        unknowns.push({
          id: `charges.${key}.missing`,
          name: label,
          reason: `${key} was not present in getConfig output.`,
        });
      }
      continue;
    }

    if (config[key] === true) {
      assumptions.push({
        id: `charges.${key}.enabled`,
        name: `${label} enabled`,
        state: "enabled",
        classification: "conditional",
        severity: severityFor("charge"),
        confidence: "high",
        data_kind: "direct_from_pob_config",
        evidence: [`${key}=true`],
        impact: `Displayed stats may assume ${label.toLowerCase()} uptime; this tool does not prove generation or uptime.`,
        suggested_next_test: `Compare relevant stats with ${key}=false and inspect charge sources with charge-specific tools.`,
      });
    }
  }
}

function appendConditionFindings(
  assumptions: AssumptionFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  for (const [key, value] of sortedEntries(config)) {
    if (!key.startsWith("condition") || value !== true) continue;
    assumptions.push({
      id: `condition.${key}.enabled`,
      name: readableConfigName(key),
      state: "enabled",
      classification: classifyCondition(key),
      severity: severityFor("enemy_condition"),
      confidence: "high",
      data_kind: "direct_from_pob_config",
      evidence: [`${key}=true`],
      impact: "Displayed stats may rely on a conditional configuration flag.",
      suggested_next_test: `Compare relevant stats with ${key}=false and verify the condition in the intended scenario.`,
    });
  }
}

function appendBuffFindings(
  assumptions: AssumptionFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  for (const [key, value] of sortedEntries(config)) {
    if (!key.startsWith("buff") || value !== true) continue;
    const category: AssumptionCategory = GUARD_BUFF_KEYS.has(key) ? "guard_skill" : "buff";
    assumptions.push({
      id: `buff.${key}.enabled`,
      name: readableConfigName(key),
      state: "enabled",
      classification: category === "guard_skill" ? "guard_skill_dependent" : "conditional",
      severity: severityFor(category),
      confidence: "high",
      data_kind: "direct_from_pob_config",
      evidence: [`${key}=true`],
      impact: "Displayed stats may rely on a temporary or conditional buff.",
      suggested_next_test: `Compare relevant stats with ${key}=false and verify uptime in the intended scenario.`,
    });
  }
}

function appendEnemySettingFindings(
  assumptions: AssumptionFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  const evidence: string[] = [];
  for (const [key, value] of sortedEntries(config)) {
    if (!key.startsWith("enemy") || isEmptyConfigValue(value)) continue;
    if (key in DEFAULT_ENEMY_CONFIG && configValueEquals(DEFAULT_ENEMY_CONFIG[key], value)) continue;
    evidence.push(`${key}=${String(value)}`);
  }

  if (evidence.length === 0) return;

  assumptions.push({
    id: "enemy.configuration.overrides",
    name: "Enemy configuration overrides",
    state: "configured",
    classification: "needs_verification",
    severity: severityFor("enemy_setting"),
    confidence: "high",
    data_kind: "direct_from_pob_config",
    evidence,
    impact: "Displayed offense or defense numbers may depend on non-default enemy configuration assumptions.",
    suggested_next_test: "Confirm these enemy settings match the mapping or bossing scenario being compared.",
  });
}

function appendMultiplierFindings(
  assumptions: AssumptionFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  for (const [key, value] of sortedEntries(config)) {
    if (!key.startsWith("multiplier") || isEmptyConfigValue(value) || value === 0) continue;
    assumptions.push({
      id: `multiplier.${key}.set`,
      name: readableConfigName(key),
      state: String(value),
      classification: "needs_verification",
      severity: severityFor("multiplier"),
      confidence: "high",
      data_kind: "direct_from_pob_config",
      evidence: [`${key}=${String(value)}`],
      impact: "Displayed numbers may rely on a configured stack count or multiplier value.",
      suggested_next_test: `Verify ${key} uptime or compare with a lower value.`,
    });
  }
}

function appendCustomModFindings(
  assumptions: AssumptionFinding[],
  config: Record<string, unknown>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  const customMods = config.customMods;
  if (typeof customMods !== "string" || customMods.trim().length === 0) return;
  assumptions.push({
    id: "customMods.present",
    name: "Custom modifiers present",
    state: "present",
    classification: "needs_verification",
    severity: severityFor("custom_mod"),
    confidence: "high",
    data_kind: "direct_from_pob_config",
    evidence: customMods.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    impact: "Custom modifiers can materially change calculated stats and need manual validation.",
    suggested_next_test: "Review each custom modifier and compare stats with customMods cleared.",
  });
}

function appendFlaskFindings(
  assumptions: AssumptionFinding[],
  unknowns: UnknownFinding[],
  items: DataResult<any[]>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  if (!Array.isArray(items.value)) {
    unknowns.push({
      id: "flasks.unavailable",
      name: "Flask active state",
      reason: items.error || "getItems returned no item data.",
    });
    return;
  }

  const flasks = items.value.filter(item => isObject(item) && String(item.slot || "").startsWith("Flask ") && item.id !== 0);
  if (flasks.length === 0) {
    unknowns.push({
      id: "flasks.none_detected",
      name: "Flask active state",
      reason: "No equipped flask entries were present in getItems output.",
    });
    return;
  }

  const activeFlasks = flasks.filter(flask => flask.active === true);
  if (activeFlasks.length === 0) return;

  assumptions.push({
    id: "flasks.active",
    name: "Flasks active in config",
    state: `${activeFlasks.length}/${flasks.length} active`,
    classification: "flask_dependent",
    severity: severityFor("flask"),
    confidence: "high",
    data_kind: "direct_from_pob",
    evidence: activeFlasks.map(flask => `${String(flask.slot || "Flask")}: ${String(flask.name || flask.baseName || "unknown flask")} active=true`),
    impact: "Displayed offense or defense numbers may include flask uptime.",
    suggested_next_test: "Compare relevant stats with active flasks disabled and inspect flask sustain for the target scenario.",
  });
}

function appendSkillFindings(
  assumptions: AssumptionFinding[],
  unknowns: UnknownFinding[],
  skills: DataResult<any>,
  severityFor: (category: AssumptionCategory) => AssumptionSeverity
) {
  if (!skills.value || !isObject(skills.value)) {
    unknowns.push({
      id: "skills.unavailable",
      name: "Vaal and guard skill state",
      reason: skills.error || "getSkills returned no skill data.",
    });
    return;
  }

  const groups = Array.isArray(skills.value.groups) ? skills.value.groups : [];
  if (groups.length === 0) {
    unknowns.push({
      id: "skills.groups_missing",
      name: "Vaal and guard skill state",
      reason: "getSkills did not expose socket groups.",
    });
    return;
  }

  const { names: enabledGemNames, ambiguous } = collectEnabledGemNames(groups);
  unknowns.push(...ambiguous);
  const vaalGems = enabledGemNames.filter(name => /\bVaal\b/i.test(name));
  const guardGems = enabledGemNames.filter(name => GUARD_SKILLS.some(guard => sameName(name, guard)));

  if (vaalGems.length > 0) {
    assumptions.push({
      id: "skills.vaal.enabled",
      name: "Enabled Vaal skills detected",
      state: "enabled",
      classification: "burst_only",
      severity: severityFor("vaal_skill"),
      confidence: "medium",
      data_kind: "direct_from_pob",
      evidence: mergeUnique(vaalGems),
      impact: "Displayed damage or survivability may include burst-only Vaal skill windows.",
      suggested_next_test: "Compare relevant stats or rotations without relying on Vaal skill uptime.",
    });
  }

  if (guardGems.length > 0) {
    assumptions.push({
      id: "skills.guard.enabled",
      name: "Enabled guard skills detected",
      state: "enabled",
      classification: "guard_skill_dependent",
      severity: severityFor("guard_skill"),
      confidence: "medium",
      data_kind: "direct_from_pob",
      evidence: mergeUnique(guardGems),
      impact: "Displayed survivability may include guard skill uptime or burst mitigation.",
      suggested_next_test: "Compare defenses with guard skill assumptions disabled or during guard downtime.",
    });
  }
}

function collectEnabledGemNames(groups: any[]): { names: string[]; ambiguous: UnknownFinding[] } {
  const names: string[] = [];
  const ambiguous: UnknownFinding[] = [];
  for (const group of groups) {
    if (!isObject(group) || group.enabled === false || !Array.isArray(group.gems)) continue;
    if (group.enabled !== true) {
      ambiguous.push({
        id: `skills.group.${String(group.index ?? "unknown")}.enabled_unknown`,
        name: "Socket group enabled state",
        reason: "getSkills exposed a socket group without an explicit enabled=true/false state.",
      });
      continue;
    }
    for (const gem of group.gems) {
      if (!isObject(gem) || gem.enabled === false) continue;
      if (gem.enabled !== true) {
        ambiguous.push({
          id: `skills.gem.${String(gem.index ?? gem.name ?? "unknown")}.enabled_unknown`,
          name: "Gem enabled state",
          reason: "getSkills exposed a gem without an explicit enabled=true/false state.",
        });
        continue;
      }
      const name = gem.name ?? gem.gemName ?? gem.id;
      if (typeof name === "string" && name.trim().length > 0) names.push(name.trim());
    }
  }
  return { names, ambiguous };
}

function summarize(assumptions: AssumptionFinding[], unknowns: UnknownFinding[]) {
  const critical_count = assumptions.filter(item => item.severity === "critical").length;
  const warning_count = assumptions.filter(item => item.severity === "warning").length;
  const info_count = assumptions.filter(item => item.severity === "info").length;
  const unknown_count = unknowns.length;
  const overall: AssumptionSeverity =
    critical_count > 0 ? "critical" :
    warning_count > 0 ? "warning" :
    unknown_count > 0 && info_count === 0 ? "unknown" :
    "info";
  const confidence: Confidence =
    assumptions.length === 0 ? "low" :
    unknown_count === 0 ? "high" :
    unknown_count > assumptions.length ? "low" :
    "medium";

  return {
    overall,
    confidence,
    critical_count,
    warning_count,
    info_count,
    unknown_count,
  };
}

function classifyCondition(key: string): Classification {
  const lower = key.toLowerCase();
  if (lower.includes("killed") || lower.includes("kill")) return "on_kill_only";
  return "conditional";
}

function readableConfigName(key: string): string {
  return key
    .replace(/^(condition|buff|enemy|multiplier)/, "")
    .replace(/([A-Z])/g, " $1")
    .trim() || key;
}

function sortedEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(obj).sort(([left], [right]) => left.localeCompare(right));
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyConfigValue(value: unknown): boolean {
  return value == null || value === false || (typeof value === "string" && value.trim().length === 0);
}

function configValueEquals(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "string" && right.trim() !== "") {
    return left === Number(right);
  }
  return left === right;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
