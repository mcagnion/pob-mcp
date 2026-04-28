/**
 * Item Shopping Advisor
 *
 * Generates a "shopping spec" description of what stats/mods to look for
 * in a given gear slot, based on the currently loaded build. No trade API
 * required — the output is a human-readable guide for manual searching.
 */

import type { PoBLuaApiClient } from '../pobLuaBridge.js';
import { wrapHandler } from '../utils/errorHandling.js';

export interface ItemShoppingContext {
  getLuaClient: () => PoBLuaApiClient | null;
}

const MECHANICS_FRESHNESS_NOTE =
  'Static slot/base notes can become stale across PoE patches. Verify enchants, Heist/Hillock quality, Harvest, Eldritch, influence, corruption, and Watcher\'s Eye mechanics against current PoB data or live trade filters before treating them as available.';

// Slot-specific knowledge: which mods matter and what the base options are
const SLOT_KNOWLEDGE: Record<string, {
  label: string;
  suggestedBases: string[];
  universalMods: string[];
  notes: string;
  tradeFilters: string[];
}> = {
  'Boots': {
    label: 'Boots',
    suggestedBases: [
      'Two-Toned Boots (Armour/ES) — most flexible, good for hybrid defences',
      'Sorcerer Boots — max ES for energy shield builds',
      'Crusader Boots — for high ES + movement speed',
    ],
    universalMods: ['30%+ Movement Speed (mandatory suffix)'],
    notes: 'Movement speed is non-negotiable — prioritize it first. Aim for 30-35%.',
    tradeFilters: ['Movement Speed ≥ 30%'],
  },
  'Gloves': {
    label: 'Gloves',
    suggestedBases: [
      'Spiked Gloves — adds melee physical damage (attack builds)',
      'Fingerless Silk Gloves — adds spell damage',
      'Crusader Gloves — ES/armour hybrid',
      'Paladin Gloves — armour/ES with influence potential',
    ],
    universalMods: [],
    notes: 'Gloves can roll accuracy, attack speed, and added damage — valuable for attack builds. Caster builds prioritize life/res/stats.',
    tradeFilters: [],
  },
  'Helmet': {
    label: 'Helmet',
    suggestedBases: [
      'Hubris Circlet — highest ES base for spell builds',
      'Eternal Burgonet — highest armour base',
      'Bone Helmet — minion-themed base; verify current implicit/mod availability before targeting it',
      'Starkonja\'s Head / rare open prefix for elder mods',
    ],
    universalMods: [],
    notes: 'Helmet enchants and special implicits are version-sensitive. Do not pay a premium for an old Lab/Heist enchant unless current PoB data or live trade filters confirm it exists for the league.',
    tradeFilters: [],
  },
  'Body Armour': {
    label: 'Body Armour',
    suggestedBases: [
      'Astral Plate — max life + strength, best for life builds',
      'Vaal Regalia — highest ES base for spell builds',
      'Occultist\'s Vestment — ES/int hybrid',
      'Sacred Chainmail — armour/ES hybrid',
    ],
    universalMods: [],
    notes: 'Body armour can have 6 sockets for your main skill. A 6-link is often the most impactful single upgrade. Also look for % increased max life or ES.',
    tradeFilters: ['6 linked sockets (if you need the 6-link)'],
  },
  'Amulet': {
    label: 'Amulet',
    suggestedBases: [
      'Onyx Amulet — +10-16 to all attributes (best universal base)',
      'Citrine Amulet — +20-30 STR/DEX',
      'Jade Amulet — high dexterity',
      'Lapis Amulet — high intelligence',
    ],
    universalMods: [],
    notes: 'Amulets can be anointed with Notable passive effects using Oils. Check which anointment is best for your build before buying.',
    tradeFilters: [],
  },
  'Belt': {
    label: 'Belt',
    suggestedBases: [
      'Stygian Vise — has an Abyss jewel socket for extra stats',
      'Heavy Belt — +35 strength (useful for coloring gear)',
      'Leather Belt — +25-40 maximum life implicit',
      'Crystal Belt — +60-80 ES implicit (ES builds)',
      'Vanguard Belt — armour/evasion implicit (hybrid)',
      'Cord Belt — Can be Anointed (anoint a Notable)',
    ],
    universalMods: [],
    notes: 'Stygian Vise is the best general belt because the Abyss jewel socket adds significant stats. Cord Belt is notable if you want to anoint a passive.',
    tradeFilters: [],
  },
  'Ring 1': {
    label: 'Ring',
    suggestedBases: [
      'Amethyst Ring — +35% chaos resistance implicit (great for chaos cap)',
      'Sapphire Ring — +35% cold resistance implicit',
      'Topaz Ring — +35% lightning resistance implicit',
      'Ruby Ring — +35% fire resistance implicit',
      'Two-Stone Ring — +12-16% to two elemental resistances',
      'Vermillion Ring — +26-30 maximum life implicit',
    ],
    universalMods: [],
    notes: 'Rings are the best slot for resistance stacking. Match the base implicit to your largest resistance gap.',
    tradeFilters: [],
  },
  'Ring 2': {
    label: 'Ring',
    suggestedBases: [
      'Amethyst Ring — +35% chaos resistance implicit',
      'Sapphire Ring — +35% cold resistance implicit',
      'Topaz Ring — +35% lightning resistance implicit',
      'Ruby Ring — +35% fire resistance implicit',
      'Two-Stone Ring — +12-16% to two elemental resistances',
      'Vermillion Ring — +26-30 maximum life implicit',
    ],
    universalMods: [],
    notes: 'Rings are the best slot for resistance stacking. Match the base implicit to your largest resistance gap.',
    tradeFilters: [],
  },
  'Weapon 1': {
    label: 'Weapon (Main Hand)',
    suggestedBases: [],
    universalMods: [],
    notes: 'Weapon upgrades depend heavily on your skill. Prioritize whichever damage type your skill scales with (physical DPS, elemental damage, spell damage, crit).',
    tradeFilters: [],
  },
  'Weapon 2': {
    label: 'Offhand / Shield',
    suggestedBases: [
      'Titanium Spirit Shield — highest ES shield',
      'Pinnacle Tower Shield — highest block chance',
      'Fossilised Spirit Shield — ES hybrid',
    ],
    universalMods: [],
    notes: 'If using a shield, prioritize block chance + ES or life. Check if "Chance to Block Spell Damage" is important for your build.',
    tradeFilters: [],
  },
};

function getSlotKnowledge(slot: string) {
  return SLOT_KNOWLEDGE[slot] ?? {
    label: slot,
    suggestedBases: [],
    universalMods: [],
    notes: '',
    tradeFilters: [],
  };
}

function resistLabel(pct: number): string {
  if (pct >= 40) return 'critical';
  if (pct >= 20) return 'high';
  if (pct >= 10) return 'moderate';
  return 'minor';
}

const ITEM_SOURCE_FLAGS = new Set([
  'Corrupted', 'Fractured Item', 'Mirrored', 'Split', 'Synthesised Item',
  'Veiled Prefix', 'Veiled Suffix', 'Elder Item', 'Shaper Item',
  'Warlord Item', 'Crusader Item', 'Redeemer Item', 'Hunter Item',
  'Searing Exarch Item', 'Eater of Worlds Item',
]);

type ItemModType = 'enchant' | 'implicit' | 'explicit' | 'crafted' | 'fractured' | 'scourge' | 'crucible';

interface ParsedItemMod {
  line: string;
  type: ItemModType;
}

interface ParsedCurrentItem {
  mods: ParsedItemMod[];
  flags: string[];
  anoints: string[];
  hasCraftedMod: boolean;
  sockets: {
    total: number;
    maxLinked: number;
    summary: string | null;
  };
  stats: {
    life: number;
    energyShield: number;
    fireResist: number;
    coldResist: number;
    lightningResist: number;
    chaosResist: number;
    movementSpeed: number;
  };
}

function cleanRawModLine(rawLine: string): { line: string; typeHints: Set<string> } {
  const typeHints = new Set<string>();
  const line = rawLine
    .replace(/\{(\w+)(?::[^}]*)?\}/g, (_m, tag) => {
      typeHints.add(String(tag));
      return '';
    })
    .replace(/\s*\((implicit|enchant|crafted|fractured)\)\s*$/i, (_m, tag) => {
      typeHints.add(String(tag).toLowerCase());
      return '';
    })
    .trim();

  return { line, typeHints };
}

function parseCurrentItem(raw: string | undefined): ParsedCurrentItem | null {
  if (!raw) return null;

  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  const mods: ParsedItemMod[] = [];
  const flags: string[] = [];
  let socketGroups: string[] = [];
  let implicitTotal = 0;
  let pastImplicitsLine = false;
  let implicitCount = 0;
  let enchantCount = 0;

  for (const rawLine of lines) {
    const socketsMatch = rawLine.match(/^Sockets:\s*(.+)$/i);
    if (socketsMatch) {
      socketGroups = socketsMatch[1].split(/\s+/).filter(Boolean);
      continue;
    }

    if (ITEM_SOURCE_FLAGS.has(rawLine)) {
      flags.push(rawLine);
      continue;
    }

    const implicitsMatch = rawLine.match(/^Implicits:\s*(\d+)/i);
    if (implicitsMatch) {
      implicitTotal = Number(implicitsMatch[1]);
      pastImplicitsLine = true;
      continue;
    }

    if (!pastImplicitsLine) continue;
    if (/^[A-Z][A-Za-z ]+:\s/.test(rawLine) && !/^[+\-\d]/.test(rawLine)) continue;

    const { line, typeHints } = cleanRawModLine(rawLine);
    if (!line) continue;

    const totalSoFar = enchantCount + implicitCount;
    let type: ItemModType;
    if (typeHints.has('crafted') && totalSoFar < implicitTotal) {
      type = 'enchant';
      enchantCount++;
    } else if (!typeHints.has('crafted') && totalSoFar < implicitTotal) {
      type = 'implicit';
      implicitCount++;
    } else if (typeHints.has('fractured')) {
      type = 'fractured';
    } else if (typeHints.has('scourge')) {
      type = 'scourge';
    } else if (typeHints.has('crucible')) {
      type = 'crucible';
    } else if (typeHints.has('crafted')) {
      type = 'crafted';
    } else {
      type = 'explicit';
    }

    mods.push({ line, type });
  }

  return {
    mods,
    flags,
    anoints: mods.filter(mod => /\bAllocates\b/i.test(mod.line)).map(mod => mod.line),
    hasCraftedMod: mods.some(mod => mod.type === 'crafted'),
    sockets: summarizeSocketLayout(socketGroups),
    stats: summarizeItemStats(mods),
  };
}

function summarizeSocketLayout(socketGroups: string[]): ParsedCurrentItem['sockets'] {
  let total = 0;
  let maxLinked = 0;

  for (const group of socketGroups) {
    const socketCount = (group.match(/[RGBW]/gi) ?? []).length;
    total += socketCount;
    maxLinked = Math.max(maxLinked, socketCount);
  }

  if (total === 0) {
    return { total: 0, maxLinked: 0, summary: null };
  }

  const socketText = `${total} socket${total === 1 ? '' : 's'}`;
  const linkText = maxLinked > 1 ? `, ${maxLinked}-link max` : '';
  return { total, maxLinked, summary: `${socketText}${linkText}` };
}

function summarizeItemStats(mods: ParsedItemMod[]): ParsedCurrentItem['stats'] {
  const stats = {
    life: 0,
    energyShield: 0,
    fireResist: 0,
    coldResist: 0,
    lightningResist: 0,
    chaosResist: 0,
    movementSpeed: 0,
  };

  for (const mod of mods) {
    const line = mod.line;
    const life = line.match(/\+(\d+)\s+to maximum Life/i);
    if (life) stats.life += Number(life[1]);

    const energyShield = line.match(/\+(\d+)\s+to maximum Energy Shield/i);
    if (energyShield) stats.energyShield += Number(energyShield[1]);

    const movementSpeed = line.match(/(\d+)% increased Movement Speed/i);
    if (movementSpeed) stats.movementSpeed = Math.max(stats.movementSpeed, Number(movementSpeed[1]));

    const resist = line.match(/\+(\d+)%\s+to .*Resistances?/i);
    if (resist) {
      const amount = Number(resist[1]);
      const lower = line.toLowerCase();
      if (lower.includes('all elemental resistances')) {
        stats.fireResist += amount;
        stats.coldResist += amount;
        stats.lightningResist += amount;
      } else if (lower.includes('all resistances')) {
        stats.fireResist += amount;
        stats.coldResist += amount;
        stats.lightningResist += amount;
        stats.chaosResist += amount;
      } else {
        if (lower.includes('fire')) stats.fireResist += amount;
        if (lower.includes('cold')) stats.coldResist += amount;
        if (lower.includes('lightning')) stats.lightningResist += amount;
        if (lower.includes('chaos')) stats.chaosResist += amount;
      }
    }
  }

  return stats;
}

function formatStatContributions(currentItem: ParsedCurrentItem): string[] {
  const stats = currentItem.stats;
  const lines: string[] = [];
  if (stats.life > 0) lines.push(`Maximum Life: +${stats.life}`);
  if (stats.energyShield > 0) lines.push(`Maximum Energy Shield: +${stats.energyShield}`);
  if (stats.fireResist > 0) lines.push(`Fire Resistance: +${stats.fireResist}%`);
  if (stats.coldResist > 0) lines.push(`Cold Resistance: +${stats.coldResist}%`);
  if (stats.lightningResist > 0) lines.push(`Lightning Resistance: +${stats.lightningResist}%`);
  if (stats.chaosResist > 0) lines.push(`Chaos Resistance: +${stats.chaosResist}%`);
  if (stats.movementSpeed > 0) lines.push(`Movement Speed: ${stats.movementSpeed}%`);
  return lines;
}

function formatCurrentItemDiagnosis(currentItem: ParsedCurrentItem | null): string {
  if (!currentItem) {
    return [
      '## Current Item Diagnosis',
      '- Current item raw mods are unavailable; recommendations are based on build gaps only.',
      '- Do not assume open prefixes/suffixes or current affix weaknesses from this output.',
      '',
    ].join('\n');
  }

  const lines: string[] = ['## Current Item Diagnosis'];
  if (currentItem.mods.length > 0) {
    lines.push('- Relevant current mods:');
    for (const mod of currentItem.mods) {
      const tag = mod.type !== 'explicit' ? ` [${mod.type}]` : '';
      lines.push(`  - ${mod.line}${tag}`);
    }
  } else {
    lines.push('- No parseable current mods were exposed by the Lua item text.');
  }

  const contributions = formatStatContributions(currentItem);
  if (contributions.length > 0) {
    lines.push('- Parsed current item contributions:');
    for (const contribution of contributions) {
      lines.push(`  - ${contribution}`);
    }
  }

  if (currentItem.sockets.summary) {
    lines.push('- Current socket/link layout:');
    lines.push(`  - ${currentItem.sockets.summary}`);
  }

  const constraints: string[] = [];
  if (currentItem.flags.length > 0) constraints.push(...currentItem.flags);
  if (currentItem.anoints.length > 0) constraints.push(`Anointed/allocated notable: ${currentItem.anoints.join(' | ')}`);
  if (currentItem.hasCraftedMod) constraints.push('Crafted mod already present');

  if (constraints.length > 0) {
    lines.push('- Constraints and provenance:');
    for (const constraint of constraints) {
      lines.push(`  - ${constraint}`);
    }
  }

  if (currentItem.flags.includes('Corrupted') || currentItem.flags.includes('Mirrored')) {
    lines.push('- Crafting space: current item is corrupted/mirrored, so regular bench crafting should not be assumed.');
  } else if (currentItem.hasCraftedMod) {
    lines.push('- Crafting space: current item already has a crafted mod; do not assume another bench craft is available.');
  } else {
    lines.push('- Crafting space: open prefixes/suffixes are not exposed by the Lua item text; verify before planning a bench craft.');
  }

  lines.push('');
  return lines.join('\n');
}

function formatReplacementGuardrails(
  slot: string,
  currentItem: ParsedCurrentItem | null,
  currentItemRarity: string | null
): string {
  const lines: string[] = [
    '## Replacement Guardrails',
    '- Treat the filters below as search criteria, not an instruction to replace the equipped item blindly.',
  ];

  if (currentItemRarity?.toLowerCase() === 'unique') {
    lines.push('- Current item is Unique; verify unique-only mechanics or build-enabling modifiers before replacing it with a rare stat stack.');
  }

  if (!currentItem) {
    lines.push('- Current item raw mods are unavailable, so preserve any build-specific mechanics manually when comparing candidates.');
    lines.push('');
    return lines.join('\n');
  }

  const specialFlags = currentItem.flags.filter(flag => !['Corrupted', 'Mirrored'].includes(flag));
  if (specialFlags.length > 0) {
    lines.push(`- Preserve or deliberately replace special item source flags: ${specialFlags.join(', ')}.`);
  }
  if (currentItem.flags.includes('Corrupted') || currentItem.flags.includes('Mirrored')) {
    lines.push('- Current item is corrupted/mirrored; replacement candidates are usually the only practical upgrade path unless the current item is already final.');
  }
  if (currentItem.anoints.length > 0) {
    lines.push(`- Preserve the allocated notable or price replacement candidates with the same anoint: ${currentItem.anoints.join(' | ')}.`);
  }
  if (currentItem.hasCraftedMod) {
    lines.push('- Current item uses a crafted mod; compare candidates after accounting for their craft availability, not just listed explicit stats.');
  }
  if (currentItem.sockets.maxLinked >= 5) {
    lines.push(`- Preserve socket/link requirements: current ${slot} has ${currentItem.sockets.summary}; do not treat a lower-link candidate as equivalent.`);
  }

  if (lines.length === 2) {
    lines.push('- No unique, corruption, anoint, special-source, craft, or 5-link+ blocker was detected from Lua item text; still validate build-specific mechanics in PoB.');
  }

  lines.push('');
  return lines.join('\n');
}

function shouldSuggestCurrentSlotStat(currentValue: number, strongThreshold: number): boolean {
  return currentValue < strongThreshold;
}

export async function handleFindItemUpgrades(
  context: ItemShoppingContext,
  args: {
    slot: string;
    build_name?: string;
    priority?: 'dps' | 'defense' | 'resistance' | 'balanced';
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find item upgrades', async () => {
    const { slot, priority = 'balanced' } = args;
    const slotInfo = getSlotKnowledge(slot);

    // Gather build context from Lua bridge
    let buildName: string | null = null;
    let buildClass: string | null = null;
    let currentItemName: string | null = null;
    let currentItemBase: string | null = null;
    let currentItemRarity: string | null = null;
    let currentItemAnalysis: ParsedCurrentItem | null = null;

    let life = 0;
    let es = 0;
    let fireResist = 75;
    let coldResist = 75;
    let lightningResist = 75;
    let chaosResist = 0;
    let fireOverCap = 0;
    let coldOverCap = 0;
    let lightningOverCap = 0;
    let totalDps = 0;
    let str = 0;
    let dex = 0;
    let int_ = 0;

    const luaClient = context.getLuaClient();
    if (luaClient) {
      try {
        const info = await luaClient.getBuildInfo();
        buildName = info?.name ?? null;
        buildClass = info?.className && info?.ascendancy
          ? `${info.className} (${info.ascendancy})`
          : (info?.className ?? null);
      } catch { /* build info unavailable */ }

      try {
        const stats = await luaClient.getStats([
          'Life', 'EnergyShield',
          'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
          'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap',
          'TotalDPS', 'CombinedDPS',
          'Str', 'Dex', 'Int',
        ]);
        life = Number(stats?.Life ?? 0);
        es = Number(stats?.EnergyShield ?? 0);
        fireResist = Number(stats?.FireResist ?? 75);
        coldResist = Number(stats?.ColdResist ?? 75);
        lightningResist = Number(stats?.LightningResist ?? 75);
        chaosResist = Number(stats?.ChaosResist ?? 0);
        fireOverCap = Number(stats?.FireResistOverCap ?? 0);
        coldOverCap = Number(stats?.ColdResistOverCap ?? 0);
        lightningOverCap = Number(stats?.LightningResistOverCap ?? 0);
        totalDps = Number(stats?.CombinedDPS ?? stats?.TotalDPS ?? 0);
        str = Number(stats?.Str ?? 0);
        dex = Number(stats?.Dex ?? 0);
        int_ = Number(stats?.Int ?? 0);
      } catch { /* stats unavailable */ }

      try {
        const items = await luaClient.getItems();
        const equipped = Array.isArray(items)
          ? items.find((i: any) => i.slot === slot)
          : null;
        if (equipped) {
          currentItemName = equipped.name ?? equipped.title ?? null;
          currentItemBase = equipped.base ?? equipped.baseName ?? equipped.type ?? null;
          currentItemRarity = equipped.rarity ?? null;
          currentItemAnalysis = parseCurrentItem(equipped.raw);
        }
      } catch { /* items unavailable */ }
    }

    // Compute resistance gaps (to cap = 75%)
    const fireMissing = Math.max(0, 75 - fireResist);
    const coldMissing = Math.max(0, 75 - coldResist);
    const lightningMissing = Math.max(0, 75 - lightningResist);
    const chaosMissing = Math.max(0, 0 - chaosResist); // chaos target is ≥ 0%

    // Life/ES assessment
    const isESBuild = es > life;
    const lifeGood = isESBuild ? es >= 4000 : life >= 4500;
    const defenceLabel = isESBuild ? 'Energy Shield' : 'Life';
    const defenceValue = isESBuild ? es : life;

    // Build output
    let text = `=== Item Shopping Spec: ${slotInfo.label} ===\n`;

    if (buildName) {
      text += `Build: ${buildName}`;
      if (buildClass) text += ` — ${buildClass}`;
      text += '\n';
    }

    if (currentItemName || currentItemBase) {
      text += `Current: ${currentItemRarity ?? 'Unknown'} — ${currentItemName ?? ''}`;
      if (currentItemBase && currentItemBase !== currentItemName) text += ` (${currentItemBase})`;
      text += '\n';
    } else if (luaClient) {
      text += `Current: (nothing equipped in this slot)\n`;
    }

    text += '\n';
    if (currentItemName || currentItemBase) {
      text += formatCurrentItemDiagnosis(currentItemAnalysis);
      text += formatReplacementGuardrails(slot, currentItemAnalysis, currentItemRarity);
    }
    text += `## Mechanics Freshness\n- ${MECHANICS_FRESHNESS_NOTE}\n\n`;

    // --- BUILD GAPS ---
    const gaps: string[] = [];
    if (!lifeGood) gaps.push(`${defenceLabel} is ${defenceValue.toLocaleString()} — target ${isESBuild ? '4000+' : '4500+'}`);
    if (fireMissing > 0) gaps.push(`Fire resist ${fireResist}% — ${fireMissing}% short of cap (${resistLabel(fireMissing)} priority)`);
    if (coldMissing > 0) gaps.push(`Cold resist ${coldResist}% — ${coldMissing}% short of cap (${resistLabel(coldMissing)} priority)`);
    if (lightningMissing > 0) gaps.push(`Lightning resist ${lightningResist}% — ${lightningMissing}% short of cap (${resistLabel(lightningMissing)} priority)`);
    if (chaosResist < 0) gaps.push(`Chaos resist ${chaosResist}% — negative, very dangerous`);
    else if (chaosResist < 20) gaps.push(`Chaos resist ${chaosResist}% — below 20%, consider improving`);

    if (gaps.length > 0) {
      text += `## Build Gaps\n`;
      for (const g of gaps) text += `- ${g}\n`;
      text += '\n';
    } else if (luaClient) {
      text += `## Build Status\n`;
      text += `- ${defenceLabel}: ${defenceValue.toLocaleString()} ✓\n`;
      text += `- Resistances: Fire ${fireResist}% / Cold ${coldResist}% / Lightning ${lightningResist}% / Chaos ${chaosResist}% ✓\n`;
      text += `- No critical gaps — this is a quality-of-life upgrade\n`;
      text += '\n';
    }

    // --- PRIORITY MODS ---
    text += `## Priority Mods (look for these first)\n`;

    // Universal slot mods
    for (const mod of slotInfo.universalMods) {
      text += `- ${mod}\n`;
    }

    // Resistance mods based on gaps
    const resMods: string[] = [];
    const currentStats = currentItemAnalysis?.stats;
    if (fireMissing >= 10 && shouldSuggestCurrentSlotStat(currentStats?.fireResist ?? 0, 25)) {
      resMods.push(`+${fireMissing + 5}–${fireMissing + 20}% to Fire Resistance`);
    }
    if (coldMissing >= 10 && shouldSuggestCurrentSlotStat(currentStats?.coldResist ?? 0, 25)) {
      resMods.push(`+${coldMissing + 5}–${coldMissing + 20}% to Cold Resistance`);
    }
    if (lightningMissing >= 10 && shouldSuggestCurrentSlotStat(currentStats?.lightningResist ?? 0, 25)) {
      resMods.push(`+${lightningMissing + 5}–${lightningMissing + 20}% to Lightning Resistance`);
    }
    if (chaosResist < 0 && shouldSuggestCurrentSlotStat(currentStats?.chaosResist ?? 0, 20)) {
      resMods.push(`+${Math.abs(chaosResist) + 10}–${Math.abs(chaosResist) + 30}% to Chaos Resistance`);
    }

    if (resMods.length > 0) {
      for (const mod of resMods) text += `- ${mod}\n`;
    }

    // Defence mods
    if (!lifeGood) {
      if (isESBuild) {
        if (shouldSuggestCurrentSlotStat(currentStats?.energyShield ?? 0, 80)) {
          text += `- +80–120 to Maximum Energy Shield\n`;
          text += `- % increased Energy Shield\n`;
        } else {
          text += `- Current item already has +${currentStats?.energyShield} Energy Shield; replace only for higher total ES or stronger secondary mods\n`;
        }
      } else {
        if (shouldSuggestCurrentSlotStat(currentStats?.life ?? 0, 70)) {
          text += `- +80–120 to Maximum Life\n`;
        } else {
          text += `- Maximum Life already present on current item (+${currentStats?.life}); solve remaining life gap in other slots unless replacing with a stronger total item\n`;
        }
      }
    } else {
      // Already fine — still suggest it as a secondary improvement
      if (isESBuild) {
        if (shouldSuggestCurrentSlotStat(currentStats?.energyShield ?? 0, 80)) {
          text += `- Additional Energy Shield (build is fine but more is always better)\n`;
        }
      } else {
        if (shouldSuggestCurrentSlotStat(currentStats?.life ?? 0, 70)) {
          text += `- Additional Life (build is fine but more is always better)\n`;
        }
      }
    }

    // Priority focus overrides
    if (priority === 'dps') {
      text += `- Damage mods relevant to your skill (added damage, crit multiplier, skill-specific stats)\n`;
    }
    if (priority === 'defense') {
      text += `- Armour, Evasion, or Energy Shield (whichever matches your defensive layer)\n`;
      text += `- Block chance (if using a shield)\n`;
    }

    if (!slotInfo.universalMods.length && resMods.length === 0 && priority !== 'dps' && priority !== 'defense') {
      const alreadyCovered = currentItemAnalysis && (
        currentItemAnalysis.stats.life >= 70 ||
        currentItemAnalysis.stats.energyShield >= 80 ||
        currentItemAnalysis.stats.fireResist >= 25 ||
        currentItemAnalysis.stats.coldResist >= 25 ||
        currentItemAnalysis.stats.lightningResist >= 25 ||
        currentItemAnalysis.stats.chaosResist >= 20
      );
      if (alreadyCovered) {
        text += `- No obvious missing defensive mod on the current item; compare replacements by total DPS/EHP and missing secondary stats\n`;
      }
    }

    text += '\n';

    // --- SECONDARY MODS ---
    text += `## Secondary Mods (nice to have)\n`;
    const secondaryRes: string[] = [];
    // Overcap suggestions — if already capped, small top-ups are still useful for reflect/map mods
    if (fireMissing === 0 && fireOverCap < 10) secondaryRes.push('Fire resistance (extra overcap)');
    if (coldMissing === 0 && coldOverCap < 10) secondaryRes.push('Cold resistance (extra overcap)');
    if (lightningMissing === 0 && lightningOverCap < 10) secondaryRes.push('Lightning resistance (extra overcap)');
    if (chaosResist >= 0 && chaosResist < 40) secondaryRes.push('Chaos resistance (40%+ is a solid target)');

    if (secondaryRes.length > 0) {
      for (const r of secondaryRes) text += `- ${r}\n`;
    }

    // Attribute checks — only flag if very low
    if (str < 100) text += `- Strength (currently ${str} — may need more for gear/gem requirements)\n`;
    if (dex < 100 && (slot === 'Boots' || slot === 'Gloves' || slot === 'Ring 1' || slot === 'Ring 2')) {
      text += `- Dexterity (currently ${dex})\n`;
    }
    if (int_ < 100 && (slot === 'Helmet' || slot === 'Amulet' || slot === 'Ring 1' || slot === 'Ring 2')) {
      text += `- Intelligence (currently ${int_})\n`;
    }

    if (!currentItemAnalysis) {
      text += `- Candidate item with a verified open prefix/suffix for bench crafting a needed stat\n`;
    } else if (currentItemAnalysis.flags.includes('Corrupted') || currentItemAnalysis.flags.includes('Mirrored')) {
      text += `- Do not rely on bench crafting this current item because it is corrupted/mirrored\n`;
    } else if (currentItemAnalysis.hasCraftedMod) {
      text += `- Current item already has a crafted mod; prefer candidates with verified crafting space if a bench craft is part of the plan\n`;
    } else {
      text += `- Candidate item with verified open prefix/suffix; current item's open affixes are unknown from Lua output\n`;
    }
    text += '\n';

    // --- BASE TYPE RECOMMENDATIONS ---
    if (slotInfo.suggestedBases.length > 0) {
      text += `## Suggested Bases\n`;
      for (const base of slotInfo.suggestedBases) {
        text += `- ${base}\n`;
      }
      text += '\n';
    }

    // --- TRADE SEARCH GUIDANCE ---
    text += `## How to Search on pathofexile.com/trade\n`;
    text += `1. Go to the trade site and select your league\n`;
    text += `2. Set Item Type: ${slotInfo.label}\n`;

    const filters: string[] = [...slotInfo.tradeFilters];
    if (fireMissing >= 10) filters.push(`Fire Resistance ≥ ${fireMissing}`);
    if (coldMissing >= 10) filters.push(`Cold Resistance ≥ ${coldMissing}`);
    if (lightningMissing >= 10) filters.push(`Lightning Resistance ≥ ${lightningMissing}`);
    if (chaosResist < 0) filters.push(`Chaos Resistance ≥ ${Math.abs(chaosResist)}`);
    if (!lifeGood && !isESBuild) filters.push('Maximum Life ≥ 60');
    if (!lifeGood && isESBuild) filters.push('Maximum Energy Shield ≥ 60');

    if (filters.length > 0) {
      text += `3. Add stat filters:\n`;
      for (const f of filters) text += `   - ${f}\n`;
      text += `4. Start broad — too many filters means few results. Add one filter at a time.\n`;
    } else {
      text += `3. Start with just the item type, then add stat filters one at a time to narrow results.\n`;
    }
    text += `5. Sort by price (cheapest first) and inspect items to compare the full mod list.\n`;
    text += `6. For rare items, you'll rarely find the exact item you want — prioritize the most important stats and be flexible on secondaries.\n`;
    text += '\n';

    // --- SLOT NOTES ---
    if (slotInfo.notes) {
      text += `## Notes\n${slotInfo.notes}\n`;
    }

    return { content: [{ type: 'text', text }] };
  });
}
