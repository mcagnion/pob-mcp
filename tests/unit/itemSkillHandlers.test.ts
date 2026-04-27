import { describe, expect, it } from '@jest/globals';
import { handleGetEquippedItems, type ItemSkillHandlerContext } from '../../src/handlers/itemSkillHandlers.js';

function makeContext(items: any[]): ItemSkillHandlerContext {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () => ({
      getItems: async () => items,
    } as any),
  };
}

describe('handleGetEquippedItems', () => {
  it('surfaces item source flags from raw PoB item text', async () => {
    const context = makeContext([
      {
        id: 1,
        slot: 'Body Armour',
        name: 'Storm Keep',
        baseName: 'Sacred Chainmail',
        rarity: 'Rare',
        raw: [
          'Rarity: Rare',
          'Storm Keep',
          'Sacred Chainmail',
          'Implicits: 2',
          '5% Chance to Block Attack Damage',
          '+1% to all maximum Elemental Resistances',
          '+100 to maximum Life',
          'Searing Exarch Item',
          'Eater of Worlds Item',
          'Crusader Item',
          'Corrupted',
        ].join('\n'),
      },
    ]);

    const result = await handleGetEquippedItems(context);
    const text = result.content[0].text;

    expect(text).toContain('Flags: Searing Exarch Item | Eater of Worlds Item | Crusader Item | Corrupted');
    expect(text).toContain('Implicit: 5% Chance to Block Attack Damage | +1% to all maximum Elemental Resistances');
    expect(text).toContain('- +100 to maximum Life');
  });
});
