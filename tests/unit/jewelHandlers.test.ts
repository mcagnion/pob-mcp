import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleListJewelSockets,
  handleAddJewel,
  type JewelHandlerContext,
} from '../../src/handlers/jewelHandlers';

interface FakeLuaState {
  treeVersion: string;
  allocatedNodes: number[];
  itemsBySlot: Map<string, { id: number; name: string; baseName?: string; rarity?: string }>;
  // When set, addItem returns this object regardless of validity, but the
  // post-mutation getItems readback uses postMutation override (simulating
  // PoB's Populate-time rejection).
  postMutationOverride?: { slot: string; entry: { id: number; name?: string } | null };
}

function makeLuaClient(state: FakeLuaState) {
  let addItemCalled = false;
  return {
    getTree: async () => ({
      treeVersion: state.treeVersion,
      nodes: state.allocatedNodes,
    }),
    getItems: async () => {
      const items: any[] = [];
      for (const [slot, entry] of state.itemsBySlot.entries()) {
        items.push({ slot, ...entry });
      }
      // Post-mutation override fires only on getItems calls AFTER addItem,
      // simulating PoB's Populate-time validity rejection that resets
      // selItemId despite SetSelItemId having succeeded.
      if (addItemCalled && state.postMutationOverride) {
        const override = state.postMutationOverride;
        state.postMutationOverride = undefined;
        const idx = items.findIndex((it) => it.slot === override.slot);
        if (override.entry === null) {
          if (idx >= 0) items[idx] = { slot: override.slot, id: 0 };
          else items.push({ slot: override.slot, id: 0 });
        } else {
          if (idx >= 0) items[idx] = { slot: override.slot, ...override.entry };
          else items.push({ slot: override.slot, ...override.entry });
        }
      }
      return items;
    },
    addItem: async (text: string, slotName?: string) => {
      addItemCalled = true;
      const id = Math.floor(Math.random() * 1_000_000) + 1;
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const name = lines[1] || lines[0] || 'Pasted Item';
      if (slotName) {
        state.itemsBySlot.set(slotName, { id, name });
      }
      return { id, name, slot: slotName };
    },
  };
}

function makeTreeService(nodeNames: Map<number, string>) {
  return {
    getTreeData: async () => ({
      version: '3_26',
      nodes: new Map(
        Array.from(nodeNames.entries()).map(([id, name]) => [
          String(id),
          { skill: id, name, isJewelSocket: true },
        ])
      ),
    }),
  } as any;
}

function makeContext(state: FakeLuaState, nodeNames: Map<number, string>): JewelHandlerContext {
  const luaClient = makeLuaClient(state);
  return {
    treeService: makeTreeService(nodeNames),
    getLuaClient: () => luaClient as any,
    ensureLuaClient: async () => {},
  };
}

const VALID_JEWEL_TEXT = [
  'Rarity: Rare',
  'Storm Heart',
  'Crimson Jewel',
  '--------',
  '+10% to Lightning Damage',
].join('\n');

describe('handleListJewelSockets', () => {
  let state: FakeLuaState;
  let nodeNames: Map<number, string>;

  beforeEach(() => {
    state = {
      treeVersion: '3_26',
      allocatedNodes: [10, 20, 30],
      itemsBySlot: new Map([
        ['Jewel 10', { id: 100, name: 'Lethal Pride', rarity: 'Unique' }],
        ['Jewel 20', { id: 0, name: '' }],
        ['Jewel 30', { id: 0, name: '' }],
        // Jewel 40 exists in slots (PoB always creates the control) but is NOT allocated.
        ['Jewel 40', { id: 0, name: '' }],
        // Equipment slot included to make sure the handler ignores it.
        ['Body Armour', { id: 999, name: 'Some Body Armour' }],
      ]),
    };
    nodeNames = new Map([
      [10, 'Lethal Pride Socket'],
      [20, 'Generic Jewel Socket'],
      [30, 'Forbidden Flame'],
      [40, 'Should Not Appear'],
    ]);
  });

  it('returns only allocated jewel sockets, intersecting Jewel slots with getTree.nodes', async () => {
    const ctx = makeContext(state, nodeNames);
    const result = await handleListJewelSockets(ctx);
    const text = result.content[0].text;
    expect(text).toContain('Allocated jewel sockets: 3');
    expect(text).toContain('1 filled, 2 empty');
    expect(text).toContain('Lethal Pride Socket');
    expect(text).toContain('Generic Jewel Socket');
    expect(text).toContain('Forbidden Flame');
    expect(text).not.toContain('Should Not Appear');
    expect(text).not.toContain('Body Armour');

    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice('data:'.length));
    expect(parsed).toHaveLength(3);
    expect(parsed.map((s: any) => s.node_id).sort((a: number, b: number) => a - b)).toEqual([10, 20, 30]);
  });

  it('handles a build with no allocated sockets', async () => {
    state.allocatedNodes = [];
    const ctx = makeContext(state, nodeNames);
    const result = await handleListJewelSockets(ctx);
    expect(result.content[0].text).toContain('No allocated jewel sockets');
  });
});

describe('handleAddJewel', () => {
  let state: FakeLuaState;
  let nodeNames: Map<number, string>;

  beforeEach(() => {
    state = {
      treeVersion: '3_26',
      allocatedNodes: [10, 20, 30],
      itemsBySlot: new Map([
        ['Jewel 10', { id: 100, name: 'Lethal Pride', rarity: 'Unique' }],
        ['Jewel 20', { id: 0, name: '' }],
        ['Jewel 30', { id: 0, name: '' }],
        ['Jewel 40', { id: 0, name: '' }],
      ]),
    };
    nodeNames = new Map([
      [10, 'Lethal Pride Socket'],
      [20, 'Generic Jewel Socket'],
      [30, 'Forbidden Flame'],
      [40, 'Inactive Socket'],
    ]);
  });

  it('places a jewel in an empty allocated socket via socket_node_id', async () => {
    const ctx = makeContext(state, nodeNames);
    const result = await handleAddJewel(ctx, VALID_JEWEL_TEXT, 20);
    const text = result.content[0].text;
    expect(text).toContain('Jewel placed in socket 20');
    expect(text).toContain('Generic Jewel Socket');
    expect(result.structured?.was_replacement).toBe(false);
    expect(result.structured?.node_id).toBe(20);
  });

  it('detects replacement when socket already has a jewel', async () => {
    const ctx = makeContext(state, nodeNames);
    const result = await handleAddJewel(ctx, VALID_JEWEL_TEXT, 10);
    const text = result.content[0].text;
    expect(text).toContain('Jewel replaced in socket 10');
    expect(text).toContain('was: Lethal Pride');
    expect(result.structured?.was_replacement).toBe(true);
  });

  it('rejects socket_node_id pointing to a non-allocated socket even if PoB has a slot control for it', async () => {
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, 40)).rejects.toThrow(
      /not an allocated jewel socket/
    );
  });

  it('throws when post-mutation readback shows the slot is still empty (PoB validation rejected the item)', async () => {
    state.postMutationOverride = { slot: 'Jewel 20', entry: null };
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, 20)).rejects.toThrow(
      /PoB validation rejected/
    );
  });

  it('throws when post-mutation readback shows a different item id (slot ended up with a stale item)', async () => {
    state.postMutationOverride = {
      slot: 'Jewel 20',
      entry: { id: 999_999, name: 'Stale Item' },
    };
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, 20)).rejects.toThrow(
      /PoB validation rejected/
    );
  });

  it('resolves socket_name with exact match', async () => {
    const ctx = makeContext(state, nodeNames);
    const result = await handleAddJewel(ctx, VALID_JEWEL_TEXT, undefined, 'Forbidden Flame');
    expect(result.structured?.node_id).toBe(30);
  });

  it('resolves socket_name with single substring match', async () => {
    const ctx = makeContext(state, nodeNames);
    const result = await handleAddJewel(ctx, VALID_JEWEL_TEXT, undefined, 'Forbidden');
    expect(result.structured?.node_id).toBe(30);
  });

  it('errors on socket_name with multiple substring matches', async () => {
    nodeNames.set(20, 'Forbidden Flesh');
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, undefined, 'Forbidden')).rejects.toThrow(
      /ambiguous/
    );
  });

  it('errors on socket_name with no match', async () => {
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, undefined, 'Nonexistent')).rejects.toThrow(
      /did not match/
    );
  });

  it('errors when neither socket_node_id nor socket_name is provided', async () => {
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT)).rejects.toThrow(
      /exactly one of socket_node_id or socket_name/
    );
  });

  it('errors when both socket_node_id and socket_name are provided', async () => {
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, VALID_JEWEL_TEXT, 20, 'Generic')).rejects.toThrow(
      /exactly one of socket_node_id or socket_name/
    );
  });

  it('errors when jewel_text is empty', async () => {
    const ctx = makeContext(state, nodeNames);
    await expect(handleAddJewel(ctx, '', 20)).rejects.toThrow(/jewel_text cannot be empty/);
  });
});
