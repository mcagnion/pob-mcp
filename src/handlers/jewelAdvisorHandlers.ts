import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import fs from "fs/promises";
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";

export interface JewelAdvisorContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface WatchersEyeMod {
  id: string;
  mod: string;
  tier: 'S' | 'A' | 'B';
  note: string;
}

interface WatchersEyeData {
  modsByAura: Map<string, WatchersEyeMod[]>;
  source: string;
}

const TIER_ORDER: Record<WatchersEyeMod['tier'], number> = { S: 0, A: 1, B: 2 };

function normalizeAuraName(name: string): string {
  return name
    .replace(/^Vaal\s+/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function unescapeLuaString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractAuraName(mod: string): string | null {
  const match = mod.match(/while affected by ([A-Za-z ]+)/);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function classifyWatchersEyeMod(mod: string): Pick<WatchersEyeMod, 'tier' | 'note'> {
  const lower = mod.toLowerCase();
  if (
    lower.includes('damage penetrates') ||
    lower.includes('critical strike multiplier') ||
    lower.includes('converted to') ||
    lower.includes('extra') ||
    lower.includes('chance to suppress') ||
    lower.includes('damage taken') ||
    lower.includes('from hits taken as') ||
    lower.includes('unaffected by')
  ) {
    return { tier: 'S', note: 'High-impact heuristic; verify value, price, and build fit.' };
  }

  if (
    lower.includes('increased attack speed') ||
    lower.includes('increased cast speed') ||
    lower.includes('critical strike chance') ||
    lower.includes('leeched') ||
    lower.includes('block') ||
    lower.includes('recovery') ||
    lower.includes('regenerate') ||
    lower.includes('additional physical damage reduction')
  ) {
    return { tier: 'A', note: 'Useful heuristic; validate against current PoB delta.' };
  }

  return { tier: 'B', note: 'Current PoB mod; situational value depends on build and market.' };
}

function parseWatchersEyeData(luaSource: string): Map<string, WatchersEyeMod[]> {
  const modsByAura = new Map<string, WatchersEyeMod[]>();

  for (const line of luaSource.split(/\r?\n/)) {
    const idMatch = line.match(/\["([^"]+)"\]\s*=/);
    if (!idMatch) continue;

    const id = idMatch[1];
    if (id.startsWith('SublimeVision') || id.startsWith('SummonArbalist')) continue;

    const statOrderIndex = line.indexOf(', statOrder');
    if (statOrderIndex < 0) continue;

    const affixIndex = line.indexOf('affix =');
    const modSegment = line.slice(affixIndex >= 0 ? affixIndex : 0, statOrderIndex);
    const strings = [...modSegment.matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map(match => unescapeLuaString(match[1]))
      .filter(value => value.trim().length > 0);
    if (strings.length === 0) continue;

    const mod = strings.join(' ').replace(/\s+/g, ' ').trim();
    const aura = extractAuraName(mod);
    if (!aura) continue;

    const classification = classifyWatchersEyeMod(mod);
    const mods = modsByAura.get(aura) ?? [];
    mods.push({ id, mod, ...classification });
    modsByAura.set(aura, mods);
  }

  for (const mods of modsByAura.values()) {
    mods.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.mod.localeCompare(b.mod));
  }

  return modsByAura;
}

async function loadWatchersEyeData(): Promise<WatchersEyeData | null> {
  const candidates = [
    process.env.POB_WATCHERS_EYE_DATA,
    process.env.POB_FORK_PATH
      ? path.join(process.env.POB_FORK_PATH, 'Data', 'Uniques', 'Special', 'WatchersEye.lua')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const source = await fs.readFile(candidate, 'utf-8');
      const modsByAura = parseWatchersEyeData(source);
      if (modsByAura.size > 0) {
        return { modsByAura, source: candidate };
      }
    } catch {
      // Try the next configured source.
    }
  }

  return null;
}

function describeWatchersEyeSource(source: string): string {
  const sourceBaseName = path.basename(source) || 'WatchersEye.lua';
  const configuredData = process.env.POB_WATCHERS_EYE_DATA;
  if (configuredData && path.resolve(configuredData) === path.resolve(source)) {
    return `current PoB data from POB_WATCHERS_EYE_DATA (${sourceBaseName})`;
  }

  const forkPath = process.env.POB_FORK_PATH;
  if (forkPath && path.resolve(source).startsWith(path.resolve(forkPath))) {
    return `current PoB data from POB_FORK_PATH (${sourceBaseName})`;
  }

  return `current PoB data (${sourceBaseName})`;
}

function detectActiveAuras(groups: any[], knownAuras: Iterable<string>): string[] {
  const knownByNormalizedName = new Map<string, string>();
  for (const aura of knownAuras) {
    knownByNormalizedName.set(normalizeAuraName(aura), aura);
  }

  const found: string[] = [];
  for (const group of groups) {
    for (const gem of (group.gems ?? [])) {
      const name: string = gem.name || gem || '';
      const aura = knownByNormalizedName.get(normalizeAuraName(name));
      if (aura) found.push(aura);
    }
  }
  return [...new Set(found)];
}

export async function handleSuggestWatchersEye(context: JewelAdvisorContext) {
  return wrapHandler('suggest watchers eye', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const skills = await luaClient.getSkills();
  const groups: any[] = skills?.groups ?? [];
  const data = await loadWatchersEyeData();

  let output = "=== Watcher's Eye Recommendations ===\n\n";

  if (!data) {
    output += "Current PoB Watcher's Eye data is unavailable, so static recommendations are suppressed.\n";
    output += "Set POB_FORK_PATH or POB_WATCHERS_EYE_DATA to a PoB fork containing Data/Uniques/Special/WatchersEye.lua.\n";
    return { content: [{ type: 'text' as const, text: output }] };
  }

  const activeAuras = detectActiveAuras(groups, data.modsByAura.keys());

  if (activeAuras.length === 0) {
    output += 'No recognized auras detected in the skill setup.\n';
    output += 'Ensure active aura gems match current PoB Watcher\'s Eye aura names.\n';
    return { content: [{ type: 'text' as const, text: output }] };
  }

  output += `Data source: ${describeWatchersEyeSource(data.source)}\n`;
  output += 'Ranking model: heuristic S/A/B labels from current PoB mod text, not a measured DPS/EHP or price ranking.\n';
  output += 'Use these as trade filters to inspect, then verify exact rolls, build delta, and market price before buying.\n\n';
  output += `**Active Auras Detected:** ${activeAuras.join(', ')}\n\n`;
  output += `A Watcher's Eye rolls mods for 2-3 aura variants. The combinations below are compatibility ideas, not BIS claims.\n\n`;

  for (const aura of activeAuras) {
    const mods = data.modsByAura.get(aura);
    if (!mods) continue;
    output += `### ${aura}\n`;
    for (const m of mods) {
      const icon = m.tier === 'S' ? '⭐' : m.tier === 'A' ? '🔷' : '🔹';
      output += `  ${icon} [${m.tier}] ${m.mod}\n`;
      output += `     _${m.note}_\n`;
    }
    output += '\n';
  }

  const sTierByAura = activeAuras
    .map(a => ({ aura: a, mods: (data.modsByAura.get(a) ?? []).filter(m => m.tier === 'S') }))
    .filter(x => x.mods.length > 0);

  if (sTierByAura.length >= 2) {
    output += '**Heuristic 2-mod combinations to inspect (S-tier labels):**\n';
    for (let i = 0; i < Math.min(sTierByAura.length, 4); i++) {
      for (let j = i + 1; j < Math.min(sTierByAura.length, 4); j++) {
        const a = sTierByAura[i];
        const b = sTierByAura[j];
        output += `  - ${a.aura}: ${a.mods[0].mod.slice(0, 45)}... + ${b.aura}: ${b.mods[0].mod.slice(0, 45)}...\n`;
      }
    }
    output += '\n';
  }

  output += `_Use \`search_trade_items\` with exact Watcher's Eye stat filters, then validate shortlisted jewels in PoB._\n`;

  return { content: [{ type: 'text' as const, text: output }] };
  });
}
