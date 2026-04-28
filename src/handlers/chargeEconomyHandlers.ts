import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface ChargeEconomyHandlerContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type ChargeKey = "power" | "frenzy" | "endurance";

interface ChargeDefinition {
  key: ChargeKey;
  label: string;
  configKey: string;
  statKeys: {
    current: string;
    maximum: string;
    minimum: string;
  };
  searchTerms: string[];
  match: RegExp;
}

interface PassiveSource {
  id: string;
  name: string;
  type?: string;
  ascendancyName?: string;
  stats: string[];
}

interface ItemSource {
  slot: string;
  name: string;
  lines: string[];
}

const CHARGE_DEFINITIONS: ChargeDefinition[] = [
  {
    key: "power",
    label: "Power Charges",
    configKey: "usePowerCharges",
    statKeys: {
      current: "PowerCharges",
      maximum: "PowerChargesMax",
      minimum: "PowerChargesMin",
    },
    searchTerms: [
      "Power Charge",
      "Power Charges",
      "Maximum Power Charge",
      "Minimum Power Charge",
      "Gain Power Charge",
    ],
    match: /\bpower charges?\b/i,
  },
  {
    key: "frenzy",
    label: "Frenzy Charges",
    configKey: "useFrenzyCharges",
    statKeys: {
      current: "FrenzyCharges",
      maximum: "FrenzyChargesMax",
      minimum: "FrenzyChargesMin",
    },
    searchTerms: [
      "Frenzy Charge",
      "Frenzy Charges",
      "Maximum Frenzy Charge",
      "Minimum Frenzy Charge",
      "Gain Frenzy Charge",
    ],
    match: /\bfrenzy charges?\b/i,
  },
  {
    key: "endurance",
    label: "Endurance Charges",
    configKey: "useEnduranceCharges",
    statKeys: {
      current: "EnduranceCharges",
      maximum: "EnduranceChargesMax",
      minimum: "EnduranceChargesMin",
    },
    searchTerms: [
      "Endurance Charge",
      "Endurance Charges",
      "Maximum Endurance Charge",
      "Minimum Endurance Charge",
      "Gain Endurance Charge",
    ],
    match: /\bendurance charges?\b/i,
  },
];

const ALL_STAT_FIELDS = Array.from(new Set(
  CHARGE_DEFINITIONS.flatMap(def => [
    def.statKeys.current,
    def.statKeys.maximum,
    def.statKeys.minimum,
  ])
));

export async function handleAnalyzeChargeEconomy(
  context: ChargeEconomyHandlerContext,
  chargeType?: string,
) {
  return wrapHandler("analyze charge economy", async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
    }

    const selected = selectChargeDefinitions(chargeType);
    const stats = await safeGetStats(luaClient);
    const config = await safeGetConfig(luaClient);
    const items = await safeGetItems(luaClient);

    const lines: string[] = [
      "=== Charge Economy Analysis ===",
      "",
      `Freshness marker: retrievedAt=${new Date().toISOString()}`,
      "Scope: current/min/max charge stats, config toggles, allocated passive sources, and equipped item mod lines.",
      "Use this before answering where charges come from; do not rely on only a Maximum/Minimum search.",
      "",
    ];

    for (const def of selected) {
      const passiveSources = await findPassiveSources(luaClient, def);
      const itemSources = findItemSources(items, def);
      appendChargeSection(lines, def, stats, config, passiveSources, itemSources);
    }

    lines.push("Search coverage:");
    lines.push("- Passive tree searches include charge, maximum, minimum, and gain wording for each requested charge type.");
    lines.push("- Item scan checks equipped item text for matching charge lines.");
    lines.push("- If a source is still missing, inspect unusual wording with search_tree_nodes and get_equipped_items.");

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  });
}

function selectChargeDefinitions(chargeType?: string): ChargeDefinition[] {
  if (!chargeType || chargeType === "all") return CHARGE_DEFINITIONS;
  const normalized = String(chargeType).trim().toLowerCase();
  const found = CHARGE_DEFINITIONS.find(def => normalized === def.key || normalized === def.label.toLowerCase());
  if (!found) {
    throw new Error(`Unknown charge_type "${chargeType}". Use one of: all, power, frenzy, endurance.`);
  }
  return [found];
}

async function safeGetStats(luaClient: PoBLuaApiClient): Promise<Record<string, any>> {
  try {
    return await luaClient.getStats(ALL_STAT_FIELDS);
  } catch {
    return {};
  }
}

async function safeGetConfig(luaClient: PoBLuaApiClient): Promise<Record<string, any>> {
  try {
    const config = await luaClient.getConfig();
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

async function safeGetItems(luaClient: PoBLuaApiClient): Promise<any[]> {
  try {
    const items = await luaClient.getItems();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function findPassiveSources(luaClient: PoBLuaApiClient, def: ChargeDefinition): Promise<PassiveSource[]> {
  const byId = new Map<string, PassiveSource>();

  for (const term of def.searchTerms) {
    let result: any;
    try {
      result = await luaClient.searchNodes({
        keyword: term,
        maxResults: 30,
        includeAllocated: true,
      });
    } catch {
      continue;
    }

    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    for (const node of nodes) {
      if (!node?.allocated) continue;
      const stats = Array.isArray(node.stats) ? (node.stats as unknown[]).map(String) : [];
      const searchable = [node.name, ...stats].filter(Boolean).join("\n");
      if (!def.match.test(searchable)) continue;

      const id = String(node.id);
      const existing = byId.get(id);
      if (existing) {
        existing.stats = mergeUnique(existing.stats, stats.filter((stat: string) => def.match.test(stat)));
        continue;
      }

      byId.set(id, {
        id,
        name: String(node.name || "Unnamed passive"),
        type: typeof node.type === "string" ? node.type : undefined,
        ascendancyName: typeof node.ascendancyName === "string" ? node.ascendancyName : undefined,
        stats: stats.filter((stat: string) => def.match.test(stat)),
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function findItemSources(items: any[], def: ChargeDefinition): ItemSource[] {
  const sources: ItemSource[] = [];

  for (const item of items) {
    if (!item || item.id === 0) continue;
    const raw = itemText(item);
    if (!raw || !def.match.test(raw)) continue;

    const matchingLines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && def.match.test(line));

    if (matchingLines.length === 0) continue;
    sources.push({
      slot: String(item.slot || "Unknown slot"),
      name: String(item.name || item.baseName || "Unknown item"),
      lines: mergeUnique([], matchingLines),
    });
  }

  return sources;
}

function itemText(item: any): string {
  const direct = item.raw || item.rawText || item.text || item.itemText;
  if (typeof direct === "string") return direct;

  const parts: string[] = [];
  for (const key of ["slot", "name", "baseName", "rarity"]) {
    if (item[key] != null) parts.push(String(item[key]));
  }
  for (const key of ["mods", "implicitMods", "explicitMods", "craftedMods", "enchantMods"]) {
    const value = item[key];
    if (Array.isArray(value)) parts.push(...value.map(String));
  }
  return parts.join("\n");
}

function appendChargeSection(
  lines: string[],
  def: ChargeDefinition,
  stats: Record<string, any>,
  config: Record<string, any>,
  passiveSources: PassiveSource[],
  itemSources: ItemSource[],
) {
  lines.push(`--- ${def.label} ---`);
  lines.push(`Stats: current=${formatMaybe(stats[def.statKeys.current])}, min=${formatMaybe(stats[def.statKeys.minimum])}, max=${formatMaybe(stats[def.statKeys.maximum])}`);
  lines.push(`Config toggle ${def.configKey}: ${formatMaybe(config[def.configKey])}`);

  lines.push("Passive sources:");
  if (passiveSources.length === 0) {
    lines.push("  - No allocated passive source found by charge keyword search.");
  } else {
    for (const source of passiveSources) {
      const type = source.type ? ` [${source.type}]` : "";
      const ascendancy = source.ascendancyName ? ` (${source.ascendancyName})` : "";
      lines.push(`  - ${source.name} [${source.id}]${type}${ascendancy}`);
      if (source.stats.length === 0) {
        lines.push("    - Matched by passive name; inspect full node text if needed.");
      } else {
        for (const stat of source.stats) lines.push(`    - ${stat}`);
      }
    }
  }

  lines.push("Item sources:");
  if (itemSources.length === 0) {
    lines.push("  - No equipped item charge mod lines found.");
  } else {
    for (const source of itemSources) {
      lines.push(`  - ${source.slot}: ${source.name}`);
      for (const line of source.lines) lines.push(`    - ${line}`);
    }
  }

  lines.push("");
}

function formatMaybe(value: any): string {
  if (value === undefined || value === null || value === "") return "unknown";
  return String(value);
}

function mergeUnique(left: string[], right: string[]): string[] {
  const seen = new Set(left);
  const merged = [...left];
  for (const value of right) {
    if (!seen.has(value)) {
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
}
