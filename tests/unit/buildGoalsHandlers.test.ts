import { describe, it, expect } from '@jest/globals';
import { handleGetBuildIssues } from '../../src/handlers/buildGoalsHandlers.js';

interface FakeStats {
  Life?: number;
  LifeUnreserved?: number;
  EnergyShield?: number;
  Mana?: number;
  ManaUnreserved?: number;
  FireResist?: number;
  ColdResist?: number;
  LightningResist?: number;
  ChaosResist?: number;
  TotalDPS?: number;
  CombinedDPS?: number;
  MinionTotalDPS?: number;
  TotalEHP?: number;
  [key: string]: number | undefined;
}

interface FakeLuaState {
  stats: FakeStats;
  buildLevel: number;
  // Items returned by get_items: PoB exposes one slot per Socket-type node in
  // the FULL tree, plus the equipment slots. Tests pass the same shape.
  items: Array<{ slot: string; id?: number; name?: string }>;
  // Allocated tree node ids (as get_tree returns them).
  allocatedNodes: number[];
  skills?: { groups: any[] };
}

function makeLuaClient(state: FakeLuaState) {
  return {
    getStats: async () => state.stats,
    getBuildInfo: async () => ({ level: state.buildLevel }),
    getTree: async () => ({ nodes: state.allocatedNodes }),
    getItems: async () => state.items,
    getSkills: async () => state.skills ?? { groups: [] },
  } as any;
}

function baseHealthyStats(): FakeStats {
  return {
    Life: 5000,
    LifeUnreserved: 4000,
    EnergyShield: 0,
    Mana: 200,
    ManaUnreserved: 100,
    FireResist: 75,
    ColdResist: 75,
    LightningResist: 75,
    ChaosResist: 0,
    SpellSuppressionChance: 0,
    EffectiveSpellSuppressionChance: 0,
    TotalDPS: 100000,
    CombinedDPS: 100000,
    MinionTotalDPS: 0,
    TotalEHP: 50000,
  };
}

function makeContext(state: FakeLuaState) {
  const client = makeLuaClient(state);
  return {
    getLuaClient: () => client,
    ensureLuaClient: async () => {},
  };
}

describe('handleGetBuildIssues — empty jewel socket count', () => {
  it('counts only allocated empty jewel sockets, not all tree sockets', async () => {
    // Tree has 21 standard jewel sockets + 4 cluster notable sockets registered
    // by PoB's ItemsTab as "Jewel <nodeId>" slots, but only 3 are allocated and
    // 1 of those 3 has a jewel equipped.
    const treeSocketIds = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008,
                           10009, 10010, 10011, 10012, 10013, 10014, 10015, 10016,
                           10017, 10018, 10019, 10020, 10021,
                           65540, 65541, 65542, 65543];
    const allocatedJewelSockets = [10001, 10002, 10003];
    const allocatedNonJewel = [42, 100, 200];

    const state: FakeLuaState = {
      stats: baseHealthyStats(),
      buildLevel: 90,
      allocatedNodes: [...allocatedNonJewel, ...allocatedJewelSockets],
      items: [
        // Equipment all filled (skip gear/flask warnings)
        { slot: 'Weapon 1', id: 1, name: 'Bow' },
        { slot: 'Weapon 2', id: 2, name: 'Quiver' },
        { slot: 'Body Armour', id: 3, name: 'Chest' },
        { slot: 'Helmet', id: 4, name: 'Helm' },
        { slot: 'Gloves', id: 5, name: 'Gloves' },
        { slot: 'Boots', id: 6, name: 'Boots' },
        { slot: 'Belt', id: 7, name: 'Belt' },
        { slot: 'Ring 1', id: 8, name: 'Ring' },
        { slot: 'Ring 2', id: 9, name: 'Ring' },
        { slot: 'Amulet', id: 10, name: 'Amulet' },
        { slot: 'Flask 1', id: 11 }, { slot: 'Flask 2', id: 12 },
        { slot: 'Flask 3', id: 13 }, { slot: 'Flask 4', id: 14 },
        { slot: 'Flask 5', id: 15 },
        // Tree jewel slots: every Socket-type node, allocated or not
        ...treeSocketIds.map((nodeId) => {
          const isAllocatedAndFilled = nodeId === 10001;
          return {
            slot: `Jewel ${nodeId}`,
            id: isAllocatedAndFilled ? 999 : 0,
            name: isAllocatedAndFilled ? 'Watcher\'s Eye' : undefined,
          };
        }),
      ],
    };

    const result = await handleGetBuildIssues(makeContext(state));
    const jewelIssue = result.issues.find((i) =>
      i.category === 'items' && i.message.includes('jewel socket(s) empty')
    );

    // 3 allocated jewel sockets, 1 has a jewel → 2 empty (not 24).
    expect(jewelIssue).toBeDefined();
    expect(jewelIssue!.message).toContain('2 jewel socket(s) empty');
    expect(jewelIssue!.message).toContain('Jewel 10002');
    expect(jewelIssue!.message).toContain('Jewel 10003');
    expect(jewelIssue!.message).not.toContain('Jewel 10004');
    expect(jewelIssue!.message).not.toContain('Jewel 65540');
  });

  it('emits no jewel-empty warning when all allocated sockets are filled', async () => {
    const state: FakeLuaState = {
      stats: baseHealthyStats(),
      buildLevel: 90,
      allocatedNodes: [10001, 10002, 65540],
      items: [
        // Equipment + flasks filled (omit boilerplate; only jewel logic matters here)
        { slot: 'Weapon 1', id: 1 }, { slot: 'Body Armour', id: 2 },
        { slot: 'Helmet', id: 3 }, { slot: 'Gloves', id: 4 },
        { slot: 'Boots', id: 5 }, { slot: 'Belt', id: 6 },
        { slot: 'Ring 1', id: 7 }, { slot: 'Ring 2', id: 8 },
        { slot: 'Amulet', id: 9 },
        { slot: 'Flask 1', id: 11 }, { slot: 'Flask 2', id: 12 },
        { slot: 'Flask 3', id: 13 }, { slot: 'Flask 4', id: 14 },
        { slot: 'Flask 5', id: 15 },
        // 21 unallocated tree sockets, all empty — must NOT trigger the warning
        ...Array.from({ length: 21 }, (_, i) => ({
          slot: `Jewel ${20000 + i}`, id: 0,
        })),
        // 3 allocated sockets, all filled
        { slot: 'Jewel 10001', id: 100, name: 'Lethal Pride' },
        { slot: 'Jewel 10002', id: 101, name: 'Watcher\'s Eye' },
        { slot: 'Jewel 65540', id: 102, name: 'Megalomaniac' },
      ],
    };

    const result = await handleGetBuildIssues(makeContext(state));
    const jewelIssue = result.issues.find((i) =>
      i.category === 'items' && i.message.includes('jewel socket(s) empty')
    );
    expect(jewelIssue).toBeUndefined();
  });

  it('ignores tree slots whose node id is not allocated even when id===0 looks empty', async () => {
    const state: FakeLuaState = {
      stats: baseHealthyStats(),
      buildLevel: 90,
      allocatedNodes: [42, 100], // no jewel sockets allocated at all
      items: [
        { slot: 'Weapon 1', id: 1 }, { slot: 'Body Armour', id: 2 },
        { slot: 'Helmet', id: 3 }, { slot: 'Gloves', id: 4 },
        { slot: 'Boots', id: 5 }, { slot: 'Belt', id: 6 },
        { slot: 'Ring 1', id: 7 }, { slot: 'Ring 2', id: 8 },
        { slot: 'Amulet', id: 9 },
        { slot: 'Flask 1', id: 11 }, { slot: 'Flask 2', id: 12 },
        { slot: 'Flask 3', id: 13 }, { slot: 'Flask 4', id: 14 },
        { slot: 'Flask 5', id: 15 },
        // 48 empty tree-jewel slots — pre-fix this would warn '48 jewel socket(s) empty'
        ...Array.from({ length: 48 }, (_, i) => ({ slot: `Jewel ${30000 + i}`, id: 0 })),
      ],
    };

    const result = await handleGetBuildIssues(makeContext(state));
    const jewelIssue = result.issues.find((i) =>
      i.category === 'items' && i.message.includes('jewel socket(s) empty')
    );
    expect(jewelIssue).toBeUndefined();
  });
});
