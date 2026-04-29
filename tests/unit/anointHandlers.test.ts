import { describe, expect, it, jest } from '@jest/globals';
import { handleFindBestAnointment } from '../../src/handlers/anointHandlers.js';

function createContext(result: unknown) {
  return {
    ensureLuaClient: jest.fn(async () => {}),
    getLuaClient: jest.fn(() => ({
      evaluateAnointCandidates: jest.fn(async () => result),
    })),
  } as any;
}

describe('handleFindBestAnointment', () => {
  it('formats current/candidate effects and secondary stat tradeoffs', async () => {
    const context = createContext({
      slot: 'Amulet',
      baseType: 'Amulet',
      focus: 'both',
      dpsMetric: 'FullDPS',
      base: { DPS: 2000, CombinedDPS: 1000, FullDPS: 2000, TotalEHP: 5000 },
      current: { DPS: 2020, CombinedDPS: 1020, FullDPS: 2020, TotalEHP: 5000 },
      evaluated: 2,
      skipped: 0,
      currentAnoint: {
        nodeId: 101,
        name: 'Fleetfoot',
        dpsDelta: 20,
        ehpDelta: 0,
        statLines: ['5% increased Movement Speed'],
      },
      candidates: [
        {
          nodeId: 202,
          name: 'Destroyer',
          score: 0.12,
          dpsDelta: 120,
          ehpDelta: 0,
          swapDpsDelta: 100,
          swapEhpDelta: 0,
          recipe: ['ClearOil', 'AmberOil', 'GoldenOil'],
          statLines: ['20% increased Attack Damage', '5% increased Attack Speed'],
          statDeltas: [
            {
              stat: 'EffectiveMovementSpeedMod',
              label: 'Movement Speed Modifier',
              delta: -5,
              current: 15,
              candidate: 10,
            },
            {
              stat: 'Speed',
              label: 'Attack/Cast Rate',
              delta: 0.2,
              current: 3,
              candidate: 3.2,
            },
          ],
        },
      ],
    });

    const response = await handleFindBestAnointment(context, { slot: 'Amulet', max_results: 1 });
    const text = response.content[0].text;

    expect(text).toContain('Base without anoint FullDPS: 2,000');
    expect(text).toContain('Current anoint: **Fleetfoot** [101]');
    expect(text).toContain('Current contribution vs no anoint: FullDPS delta +20');
    expect(text).toContain('Current effect:');
    expect(text).toContain('5% increased Movement Speed');
    expect(text).toContain('Candidate effect:');
    expect(text).toContain('20% increased Attack Damage');
    expect(text).toContain('FullDPS delta vs no anoint: +120');
    expect(text).toContain('Net swap vs current: FullDPS delta +100');
    expect(text).toContain('Secondary stat deltas vs current:');
    expect(text).toContain('Movement Speed Modifier: -5 (15 -> 10)');
    expect(text).toContain('Attack/Cast Rate: +0.2 (3 -> 3.2)');
    expect(text).toContain('Potential losses: Movement Speed Modifier');
  });

  it('makes missing bridge tradeoff metadata explicit', async () => {
    const context = createContext({
      slot: 'Belt',
      baseType: 'Belt',
      focus: 'dps',
      base: { CombinedDPS: 1000, TotalEHP: 5000 },
      evaluated: 1,
      skipped: 0,
      candidates: [
        {
          nodeId: 303,
          name: 'Unannotated Notable',
          score: 0.05,
          dpsDelta: 50,
          ehpDelta: 0,
        },
      ],
    });

    const response = await handleFindBestAnointment(context, { slot: 'Belt', focus: 'dps' });
    const text = response.content[0].text;

    expect(text).toContain('Current anoint: unavailable from PoB bridge');
    expect(text).toContain('Current contribution vs no anoint: unavailable from PoB bridge');
    expect(text).toContain('Net swap vs current: unavailable from PoB bridge');
    expect(text).toContain('Candidate effect: unavailable from PoB bridge');
    expect(text).toContain('Secondary stat deltas vs current: unavailable from PoB bridge');
  });

  it('distinguishes no current anoint from unavailable metadata', async () => {
    const context = createContext({
      slot: 'Amulet',
      baseType: 'Amulet',
      focus: 'both',
      base: { CombinedDPS: 1000, TotalEHP: 5000 },
      current: { CombinedDPS: 1000, TotalEHP: 5000 },
      evaluated: 1,
      skipped: 0,
      currentAnoint: null,
      candidates: [
        {
          nodeId: 404,
          name: 'Clean Upgrade',
          score: 0.1,
          dpsDelta: 100,
          ehpDelta: 0,
          swapDpsDelta: 100,
          swapEhpDelta: 0,
          statLines: ['10% increased Damage'],
          statDeltas: [],
        },
      ],
    });

    const response = await handleFindBestAnointment(context, { slot: 'Amulet' });
    const text = response.content[0].text;

    expect(text).toContain('Current anoint: none detected');
    expect(text).toContain('Secondary stat deltas vs current: no display-stat changes beyond DPS/EHP');
  });
});
