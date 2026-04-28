import { describe, it, expect, jest } from '@jest/globals';
import { handleFindItemUpgrades } from '../../src/handlers/itemShoppingHandler';

function createContext(item: any, stats: Record<string, any> = {}) {
  const luaClient = {
    getBuildInfo: jest.fn(async () => ({
      name: 'Fixture Build',
      className: 'Templar',
      ascendancy: 'Hierophant',
    })),
    getStats: jest.fn(async () => ({
      Life: 3200,
      EnergyShield: 0,
      FireResist: 50,
      ColdResist: 60,
      LightningResist: 75,
      ChaosResist: 10,
      FireResistOverCap: 0,
      ColdResistOverCap: 0,
      LightningResistOverCap: 0,
      TotalDPS: 100000,
      CombinedDPS: 120000,
      Str: 150,
      Dex: 150,
      Int: 150,
      ...stats,
    })),
    getItems: jest.fn(async () => [item]),
  };

  return {
    getLuaClient: () => luaClient as any,
  };
}

describe('handleFindItemUpgrades', () => {
  it('diagnoses the equipped item and does not repeat generic life advice when life is already strong', async () => {
    const context = createContext({
      slot: 'Gloves',
      id: 1,
      name: 'Havoc Grip',
      baseName: 'Fingerless Silk Gloves',
      rarity: 'Rare',
      raw: [
        'Rarity: Rare',
        'Havoc Grip',
        'Fingerless Silk Gloves',
        'Implicits: 1',
        '16% increased Spell Damage',
        '+102 to maximum Life',
        '+46% to Fire Resistance',
        '+38% to Cold Resistance',
      ].join('\n'),
    });

    const result = await handleFindItemUpgrades(context, {
      slot: 'Gloves',
      priority: 'balanced',
    });

    const text = result.content[0].text;
    expect(text).toContain('## Current Item Diagnosis');
    expect(text).toContain('+102 to maximum Life');
    expect(text).toContain('Maximum Life already present on current item (+102)');
    expect(text).toContain('Fire Resistance: +46%');
    expect(text).not.toContain('+80–120 to Maximum Life');
    expect(text).not.toContain('Any open prefix/suffix');
    expect(text).toContain("current item's open affixes are unknown");
  });

  it('surfaces corruption, influence, anoint, and crafted-mod constraints', async () => {
    const context = createContext({
      slot: 'Belt',
      id: 2,
      name: 'Rune Tether',
      baseName: 'Cord Belt',
      rarity: 'Rare',
      raw: [
        'Rarity: Rare',
        'Rune Tether',
        'Cord Belt',
        'Implicits: 1',
        'Allocates Prismatic Skin',
        '+55 to maximum Life',
        '{crafted}+30% to Lightning Resistance',
        'Searing Exarch Item',
        'Corrupted',
      ].join('\n'),
    });

    const result = await handleFindItemUpgrades(context, {
      slot: 'Belt',
      priority: 'balanced',
    });

    const text = result.content[0].text;
    expect(text).toContain('Constraints and provenance');
    expect(text).toContain('Searing Exarch Item');
    expect(text).toContain('Corrupted');
    expect(text).toContain('Anointed/allocated notable: Allocates Prismatic Skin');
    expect(text).toContain('Crafted mod already present');
    expect(text).toContain('regular bench crafting should not be assumed');
  });

  it('warns that unique linked items need build-mechanic and link preservation before replacement', async () => {
    const context = createContext({
      slot: 'Body Armour',
      id: 3,
      name: 'Loreweave',
      baseName: 'Elegant Ringmail',
      rarity: 'Unique',
      raw: [
        'Rarity: Unique',
        'Loreweave',
        'Elegant Ringmail',
        'Sockets: R-R-R-R-R-R',
        'Implicits: 0',
        '+50 to maximum Life',
        '+30% to Fire Resistance',
        '+30% to Cold Resistance',
        '+30% to Lightning Resistance',
      ].join('\n'),
    });

    const result = await handleFindItemUpgrades(context, {
      slot: 'Body Armour',
      priority: 'balanced',
    });

    const text = result.content[0].text;
    expect(text).toContain('## Replacement Guardrails');
    expect(text).toContain('not an instruction to replace the equipped item blindly');
    expect(text).toContain('Current item is Unique');
    expect(text).toContain('unique-only mechanics or build-enabling modifiers');
    expect(text).toContain('Current socket/link layout');
    expect(text).toContain('6 sockets, 6-link max');
    expect(text).toContain('do not treat a lower-link candidate as equivalent');
  });
});
