import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface ItemSkillHandlerContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

export async function handleAddItem(
  context: ItemSkillHandlerContext,
  itemText: string,
  slotName?: string,
  noAutoEquip?: boolean
) {
  return wrapHandler('add item', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!itemText || itemText.trim().length === 0) {
      throw new Error('item_text cannot be empty');
    }

    const result = await luaClient.addItem(itemText, slotName, noAutoEquip);

    const text = `✅ Item added: ${result.name || 'Unknown'} → ${result.slot || 'Not equipped'}`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

// Known non-mod flag/trailer lines that appear in PoB raw item text.
const ITEM_FLAG_LINES = new Set([
  'Corrupted', 'Fractured Item', 'Mirrored', 'Split', 'Synthesised Item',
  'Veiled Prefix', 'Veiled Suffix', 'Elder Item', 'Shaper Item',
  'Warlord Item', 'Crusader Item', 'Redeemer Item', 'Hunter Item',
  'Searing Exarch Item', 'Eater of Worlds Item',
]);

interface ModLine { line: string; type: string; }
interface ParsedItemRaw { mods: ModLine[]; flags: string[]; }

const GEM_QUALITY_VERIFICATION_FIELDS = [
  'FullDPS',
  'FullDotDPS',
  'TotalDPS',
  'CombinedDPS',
  'TotalDotDPS',
  'Speed',
  'ManaCost',
];

function getNumericStat(stats: Record<string, any> | null, field: string): number | null {
  if (!stats || stats[field] == null) return null;
  const value = Number(stats[field]);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatStatDelta(field: string, before: number | null, after: number | null): string | null {
  if (before == null && after == null) return null;
  if (before == null) return `${field}: ${formatNumber(after as number)} (post-mutation)`;
  if (after == null) return `${field}: unavailable after mutation (was ${formatNumber(before)})`;
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  return `${field}: ${formatNumber(before)} -> ${formatNumber(after)} (${sign}${formatNumber(delta)})`;
}

async function readStatsForGemQuality(luaClient: PoBLuaApiClient): Promise<Record<string, any> | null> {
  try {
    return await luaClient.getStats(GEM_QUALITY_VERIFICATION_FIELDS);
  } catch {
    return null;
  }
}

async function readGemAfterMutation(
  luaClient: PoBLuaApiClient,
  groupIndex: number,
  gemIndex: number
): Promise<{ name?: string; quality?: number; qualityId?: string } | null> {
  try {
    const skills = await luaClient.getSkills();
    const groups = Array.isArray(skills?.groups) ? skills.groups : [];
    const group = groups.find((g: any) => Number(g.index) === Number(groupIndex));
    const gems = Array.isArray(group?.gems)
      ? group.gems
      : (Array.isArray(group?.gemList) ? group.gemList : []);
    const gem = gems[gemIndex - 1];
    if (!gem) return null;
    const qualityValue = gem.quality == null ? undefined : Number(gem.quality);
    return {
      name: gem.name ?? gem.nameSpec ?? gem.gemName,
      quality: Number.isFinite(qualityValue) ? qualityValue : undefined,
      qualityId: gem.qualityId,
    };
  } catch {
    return null;
  }
}

function formatGemQualityVerification(
  targetQuality: number,
  beforeStats: Record<string, any> | null,
  afterStats: Record<string, any> | null,
  gemAfter: { name?: string; quality?: number; qualityId?: string } | null
): string {
  const lines = [
    '',
    'Post-mutation verification:',
    `  Freshness marker: retrievedAt=${new Date().toISOString()}`,
  ];

  if (gemAfter) {
    const name = gemAfter.name ? `${gemAfter.name} ` : '';
    const qualityText = gemAfter.quality == null ? 'unknown quality' : `Q${gemAfter.quality}`;
    const qualityId = gemAfter.qualityId && gemAfter.qualityId !== 'Default' ? ` (${gemAfter.qualityId})` : '';
    const confirmed = gemAfter.quality === targetQuality ? 'confirmed' : 'not confirmed';
    lines.push(`  Gem readback: ${name}${qualityText}${qualityId} — target Q${targetQuality} ${confirmed}`);
  } else {
    lines.push('  Gem readback: unavailable; verify with get_skill_setup before using deltas.');
  }

  const statLines = GEM_QUALITY_VERIFICATION_FIELDS
    .map(field => formatStatDelta(field, getNumericStat(beforeStats, field), getNumericStat(afterStats, field)))
    .filter((line): line is string => Boolean(line));

  if (statLines.length > 0) {
    lines.push('  Stats readback:');
    for (const line of statLines) {
      lines.push(`    - ${line}`);
    }

    const changed = GEM_QUALITY_VERIFICATION_FIELDS.some(field => {
      const before = getNumericStat(beforeStats, field);
      const after = getNumericStat(afterStats, field);
      return before != null && after != null && before !== after;
    });

    if (!changed) {
      lines.push('  Note: no tracked stat changed. This can mean the quality has no modeled impact for the selected skill/setup; verify the active skill before ranking quality upgrades.');
    }
  } else {
    lines.push('  Stats readback: unavailable; call lua_get_stats after this mutation before making DPS claims.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Parse PoB internal item raw text to extract mod lines and item-source flags.
 * Handles both formats: with and without "Rarity:" prefix.
 * After "Implicits: N", lines are mods — first N are implicit, rest explicit.
 */
function parseItemRaw(raw: string | undefined): ParsedItemRaw {
  if (!raw) return { mods: [], flags: [] };
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const mods: ModLine[] = [];
  const flags: string[] = [];
  const seenFlags = new Set<string>();
  let implicitTotal = 0;
  let pastImplicitsLine = false;
  let enchantCount = 0;
  let implicitCount = 0;

  for (const rawLine of lines) {
    if (ITEM_FLAG_LINES.has(rawLine)) {
      if (!seenFlags.has(rawLine)) {
        flags.push(rawLine);
        seenFlags.add(rawLine);
      }
      continue;
    }

    const implicitsMatch = rawLine.match(/^Implicits:\s*(\d+)/);
    if (implicitsMatch) {
      implicitTotal = parseInt(implicitsMatch[1], 10);
      pastImplicitsLine = true;
      continue;
    }
    if (!pastImplicitsLine) continue;
    // Skip any remaining spec lines that sneak in (e.g. "Note: ...")
    if (/^[A-Z][A-Za-z ]+:\s/.test(rawLine) && !/^[+\-\d]/.test(rawLine)) continue;

    // Strip {tag} markers, collect flags
    let crafted = false, fractured = false, scourge = false, crucible = false;
    const displayLine = rawLine
      .replace(/\{(\w+)(?::[^}]*)?\}/g, (_m, tag) => {
        if (tag === 'crafted') crafted = true;
        else if (tag === 'fractured') fractured = true;
        else if (tag === 'scourge') scourge = true;
        else if (tag === 'crucible') crucible = true;
        return '';
      })
      .replace(/\s*\((implicit|enchant|crafted|fractured)\)\s*$/, '')
      .trim();

    if (!displayLine) continue;

    // Determine type using the same logic as PoB's Item.lua:
    // crafted mods within the implicit count go to enchant
    const totalSoFar = enchantCount + implicitCount;
    let type: string;
    if (crafted && totalSoFar < implicitTotal) {
      type = 'enchant'; enchantCount++;
    } else if (!crafted && totalSoFar < implicitTotal) {
      type = 'implicit'; implicitCount++;
    } else if (fractured) {
      type = 'fractured';
    } else if (scourge) {
      type = 'scourge';
    } else if (crucible) {
      type = 'crucible';
    } else if (crafted) {
      type = 'crafted';
    } else {
      type = 'explicit';
    }

    mods.push({ line: displayLine, type });
  }
  return { mods, flags };
}

export async function handleGetEquippedItems(context: ItemSkillHandlerContext) {
  return wrapHandler('get equipped items', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const items = await luaClient.getItems();

    let text = "=== Equipped Items ===\n\n";

    if (!items || items.length === 0) {
      text += "No items equipped.\n";
    } else {
      const equipped = items.filter((item: any) => item.id !== 0 && item.name);
      if (equipped.length === 0) {
        text += "No items equipped.\n";
      } else {
        for (const item of equipped) {
          text += `**${item.slot}**\n`;
          text += `  ${item.name}`;
          if (item.baseName && item.baseName !== item.name) {
            text += ` (${item.baseName})`;
          }
          text += `\n`;
          if (item.rarity) {
            text += `  Rarity: ${item.rarity}\n`;
          }
          if (item.active !== undefined) {
            text += `  Active: ${item.active ? 'Yes' : 'No'}\n`;
          }
          const parsed = parseItemRaw(item.raw);
          if (parsed.flags.length > 0) {
            text += `  Flags: ${parsed.flags.join(' | ')}\n`;
          }
          const mods = parsed.mods;
          if (mods.length > 0) {
            const enchants = mods.filter(m => m.type === 'enchant');
            const implicits = mods.filter(m => m.type === 'implicit');
            const explicits = mods.filter(m => !['enchant', 'implicit'].includes(m.type));
            if (enchants.length > 0) {
              text += `  Enchant: ${enchants.map(m => m.line).join(' | ')}\n`;
            }
            if (implicits.length > 0) {
              text += `  Implicit: ${implicits.map(m => m.line).join(' | ')}\n`;
            }
            if (explicits.length > 0) {
              text += `  Mods:\n`;
              for (const m of explicits) {
                const tag = m.type !== 'explicit' ? ` [${m.type}]` : '';
                text += `    - ${m.line}${tag}\n`;
              }
            }
          }
          text += "\n";
        }
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleToggleFlask(
  context: ItemSkillHandlerContext,
  flaskNumber: number,
  active: boolean
) {
  return wrapHandler('toggle flask', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (flaskNumber < 1 || flaskNumber > 5) {
      throw new Error('flask_number must be between 1 and 5');
    }

    await luaClient.setFlaskActive(flaskNumber, active);

    let text = `✅ Flask ${flaskNumber} ${active ? 'activated' : 'deactivated'}.`;

    // Return updated key defensive stats so the effect is visible immediately
    try {
      const stats = await luaClient.getStats([
        'Life', 'Armour', 'Evasion', 'EnergyShield',
        'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
        'PhysicalDamageReduction', 'ManaUnreserved',
      ]);
      const fmt = (v: any) => v != null ? String(v) : '-';
      text += `\n\nUpdated stats:\n`;
      text += `  Life: ${fmt(stats.Life)}  |  Armour: ${fmt(stats.Armour)}  |  Evasion: ${fmt(stats.Evasion)}\n`;
      text += `  Fire: ${fmt(stats.FireResist)}%  Cold: ${fmt(stats.ColdResist)}%  Lightning: ${fmt(stats.LightningResist)}%  Chaos: ${fmt(stats.ChaosResist)}%\n`;
      if (stats.PhysicalDamageReduction != null) {
        text += `  PDR: ${fmt(stats.PhysicalDamageReduction)}%\n`;
      }
    } catch {}

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleGetSkillSetup(context: ItemSkillHandlerContext, mainOnly: boolean = true) {
  return wrapHandler('get skill setup', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const skillData = await luaClient.getSkills();

    if (!skillData || typeof skillData !== 'object') {
      throw new Error('No build loaded. Use lua_load_build or lua_new_build first.');
    }

    let text = "=== Skill Setup ===\n\n";
    text += `Main Socket Group: ${skillData.mainSocketGroup || 'None'}\n\n`;

    if (!skillData.groups || skillData.groups.length === 0) {
      text += "No skill groups found.\n";
    } else {
      const totalGroups = skillData.groups.length;
      const groups = mainOnly
        ? skillData.groups.filter((g: any) => g.index === skillData.mainSocketGroup)
        : skillData.groups;

      if (mainOnly && totalGroups > 1) {
        text += `(Showing main skill group only. Use main_only=false to see all ${totalGroups} groups.)\n\n`;
      }

      for (const group of groups) {
        const isMain = group.index === skillData.mainSocketGroup;
        text += `**Group ${group.index}${isMain ? ' (MAIN)' : ''}**\n`;
        if (group.label) {
          text += `  Label: ${group.label}\n`;
        }
        if (group.slot) {
          text += `  Slot: ${group.slot}\n`;
        }
        text += `  Enabled: ${group.enabled ? 'Yes' : 'No'}\n`;
        text += `  Contributes to Full DPS: ${group.includeInFullDPS ? 'Yes' : 'No'}\n`;
        if (group.mainActiveSkill) {
          text += `  Main Active Skill Index: ${group.mainActiveSkill}\n`;
        }
        if (group.skills && group.skills.length > 0) {
          text += `  Active Skills: ${group.skills.join(', ')}\n`;
        }
        if (group.gems && group.gems.length > 0) {
          text += `  Gems (${group.gems.length}):\n`;
          for (const gem of group.gems) {
            const lvlQual = `${gem.level}/${gem.quality}`;
            text += `    ${gem.index}. ${gem.name} (${lvlQual})${gem.enabled === false ? ' [disabled]' : ''}\n`;
          }
        }
        text += "\n";
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetMainSkill(
  context: ItemSkillHandlerContext,
  socketGroup: number,
  activeSkillIndex?: number,
  skillPart?: number
) {
  return wrapHandler('set main skill', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (socketGroup < 1) {
      throw new Error('socket_group must be >= 1');
    }

    await luaClient.setMainSelection({
      mainSocketGroup: socketGroup,
      mainActiveSkill: activeSkillIndex,
      skillPart,
    });

    let text = `✅ Main skill set to group ${socketGroup}`;
    if (activeSkillIndex !== undefined) {
      text += `, skill ${activeSkillIndex}`;
    }
    if (skillPart !== undefined) {
      text += `, part ${skillPart}`;
    }
    text += `.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleCreateSocketGroup(
  context: ItemSkillHandlerContext,
  label?: string,
  slot?: string,
  enabled?: boolean,
  includeInFullDPS?: boolean
) {
  return wrapHandler('create socket group', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const result = await luaClient.createSocketGroup({
      label,
      slot,
      enabled,
      includeInFullDPS,
    });

    let text = `✅ Socket group ${result.index} created`;
    if (label) {
      text += ` (${label})`;
    }
    text += `.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleAddGem(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemName: string,
  level?: number,
  quality?: number,
  qualityId?: string,
  enabled?: boolean
) {
  return wrapHandler('add gem', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (!gemName || gemName.trim().length === 0) {
      throw new Error('gem_name cannot be empty');
    }

    const result = await luaClient.addGem({
      groupIndex,
      gemName,
      level,
      quality,
      qualityId,
      enabled,
    });

    let text = `✅ Added ${result.name} (L${level || 20}, Q${quality || 0}) to group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetGemLevel(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  level: number
) {
  return wrapHandler('set gem level', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    if (level < 1 || level > 40) {
      throw new Error('level must be between 1 and 40');
    }

    await luaClient.setGemLevel({ groupIndex, gemIndex, level });

    let text = `✅ Set gem level to ${level} (group ${groupIndex}, gem ${gemIndex}).`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetGemQuality(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  quality: number,
  qualityId?: string
) {
  return wrapHandler('set gem quality', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    if (quality < 0 || quality > 23) {
      throw new Error('quality must be between 0 and 23');
    }

    const beforeStats = await readStatsForGemQuality(luaClient);

    await luaClient.setGemQuality({ groupIndex, gemIndex, quality, qualityId });

    let text = `✅ Set gem quality to ${quality}${qualityId && qualityId !== 'Default' ? ` (${qualityId})` : ''} (group ${groupIndex}, gem ${gemIndex}).`;
    const gemAfter = await readGemAfterMutation(luaClient, groupIndex, gemIndex);
    const afterStats = await readStatsForGemQuality(luaClient);
    text += formatGemQualityVerification(quality, beforeStats, afterStats, gemAfter);

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleRemoveSkill(
  context: ItemSkillHandlerContext,
  groupIndex: number
) {
  return wrapHandler('remove skill group', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    await luaClient.removeSkill({ groupIndex });

    let text = `✅ Removed socket group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleRemoveGem(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number
) {
  return wrapHandler('remove gem', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    await luaClient.removeGem({ groupIndex, gemIndex });

    let text = `✅ Removed gem ${gemIndex} from group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetSocketGroupEnabled(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  enabled: boolean
) {
  return wrapHandler('set socket group enabled', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    const result = await luaClient.setSocketGroupEnabled({ groupIndex, enabled });

    const label = result?.label ? ` (${result.label})` : '';
    const state = enabled ? 'enabled' : 'disabled';
    const text = `✅ Group ${groupIndex}${label} ${state}.`;

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleSetGemEnabled(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  enabled: boolean
) {
  return wrapHandler('set gem enabled', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) throw new Error('group_index must be >= 1');
    if (gemIndex < 1) throw new Error('gem_index must be >= 1');

    await luaClient.setGemEnabled({ groupIndex, gemIndex, enabled });

    const state = enabled ? 'enabled' : 'disabled';
    const text = `✅ Gem ${gemIndex} in group ${groupIndex} ${state}.`;

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleSetupSkillWithGems(
  context: ItemSkillHandlerContext,
  gems: Array<{
    name: string;
    level?: number;
    quality?: number;
    quality_id?: string;
    enabled?: boolean;
  }>,
  label?: string,
  slot?: string,
  enabled?: boolean,
  includeInFullDPS?: boolean
) {
  return wrapHandler('setup skill with gems', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!gems || gems.length === 0) {
      throw new Error('gems array cannot be empty');
    }

    // Create socket group
    const groupResult = await luaClient.createSocketGroup({
      label,
      slot,
      enabled,
      includeInFullDPS,
    });

    // Add all gems to the group
    const addedGems: string[] = [];
    for (const gem of gems) {
      if (!gem.name || gem.name.trim().length === 0) {
        throw new Error('gem name cannot be empty');
      }

      const result = await luaClient.addGem({
        groupIndex: groupResult.index,
        gemName: gem.name,
        level: gem.level,
        quality: gem.quality,
        qualityId: gem.quality_id,
        enabled: gem.enabled,
      });

      addedGems.push(`${result.name} (L${gem.level || 20}, Q${gem.quality || 0})`);
    }

    let text = `✅ Created socket group ${groupResult.index}`;
    if (label) {
      text += ` "${label}"`;
    }
    text += ` with ${addedGems.length} gem${addedGems.length > 1 ? 's' : ''}:\n`;
    text += addedGems.map(g => `  - ${g}`).join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleAddMultipleItems(
  context: ItemSkillHandlerContext,
  items: Array<{
    item_text: string;
    slot_name?: string;
  }>
) {
  return wrapHandler('add multiple items', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!items || items.length === 0) {
      throw new Error('items array cannot be empty');
    }

    const addedItems: string[] = [];
    for (const item of items) {
      if (!item.item_text || item.item_text.trim().length === 0) {
        throw new Error('item_text cannot be empty');
      }

      const result = await luaClient.addItem(item.item_text, item.slot_name);
      addedItems.push(`${result.name || 'Unknown'} → ${result.slot || 'Not equipped'}`);
    }

    let text = `✅ Added ${addedItems.length} item${addedItems.length > 1 ? 's' : ''}:\n`;
    text += addedItems.map(i => `  - ${i}`).join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}
