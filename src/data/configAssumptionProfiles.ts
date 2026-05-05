export type ConfigAssumptionProfile = "sc_trade_mapping" | "hc_trade_bossing";

export type AssumptionSeverity = "critical" | "warning" | "info" | "unknown";

export type AssumptionCategory =
  | "flask"
  | "charge"
  | "enemy_condition"
  | "buff"
  | "enemy_setting"
  | "multiplier"
  | "custom_mod"
  | "vaal_skill"
  | "guard_skill";

export interface ConfigAssumptionProfileDefinition {
  label: string;
  primaryConcern: string;
  severityByCategory: Record<AssumptionCategory, AssumptionSeverity>;
}

const SC_MAPPING_SEVERITY: Record<AssumptionCategory, AssumptionSeverity> = {
  flask: "info",
  charge: "info",
  enemy_condition: "info",
  buff: "info",
  enemy_setting: "info",
  multiplier: "warning",
  custom_mod: "warning",
  vaal_skill: "info",
  guard_skill: "warning",
};

const HC_BOSSING_SEVERITY: Record<AssumptionCategory, AssumptionSeverity> = {
  flask: "warning",
  charge: "warning",
  enemy_condition: "warning",
  buff: "warning",
  enemy_setting: "warning",
  multiplier: "warning",
  custom_mod: "warning",
  vaal_skill: "warning",
  guard_skill: "warning",
};

export const CONFIG_ASSUMPTION_PROFILES: Record<ConfigAssumptionProfile, ConfigAssumptionProfileDefinition> = {
  sc_trade_mapping: {
    label: "Softcore trade mapping",
    primaryConcern: "mapping uptime realism; conditional assumptions are mostly informational unless they are broad damage or defense inflation",
    severityByCategory: SC_MAPPING_SEVERITY,
  },
  hc_trade_bossing: {
    label: "Hardcore trade bossing",
    primaryConcern: "conservative bossing assumptions; on-kill, flask, burst, charge, and guard assumptions are treated more severely",
    severityByCategory: HC_BOSSING_SEVERITY,
  },
};

export const CONFIG_ASSUMPTION_PROFILE_VALUES = Object.keys(CONFIG_ASSUMPTION_PROFILES) as ConfigAssumptionProfile[];

export function isConfigAssumptionProfile(value: unknown): value is ConfigAssumptionProfile {
  return typeof value === "string" && value in CONFIG_ASSUMPTION_PROFILES;
}
