import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { handleSuggestWatchersEye, type JewelAdvisorContext } from '../../src/handlers/jewelAdvisorHandlers.js';

const originalWatchersEyeData = process.env.POB_WATCHERS_EYE_DATA;

function makeContext(luaClient: any): JewelAdvisorContext {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () => luaClient,
  };
}

describe('handleSuggestWatchersEye', () => {
  afterEach(() => {
    if (originalWatchersEyeData === undefined) {
      delete process.env.POB_WATCHERS_EYE_DATA;
    } else {
      process.env.POB_WATCHERS_EYE_DATA = originalWatchersEyeData;
    }
  });

  it('uses current PoB WatchersEye data instead of stale hardcoded mods', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'watchers-eye-'));
    const dataPath = path.join(dir, 'WatchersEye.lua');
    await writeFile(dataPath, `
return {
  ["DeterminationAdditionalArmour"] = { affix = "", "+(600-1000) to Armour while affected by Determination", statOrder = { 4770 }, level = 1, group = "DeterminationAdditionalArmour", },
  ["AngerFirePenetration"] = { affix = "", "Damage Penetrates (10-15)% Fire Resistance while affected by Anger", statOrder = { 9877 }, level = 1, group = "AngerFirePenetration", },
  ["SublimeVisionAnger"] = { affix = "", "Always Scorch while affected by Anger", statOrder = { 10667 }, level = 1, group = "SublimeVisionAnger", },
}
`, 'utf-8');

    process.env.POB_WATCHERS_EYE_DATA = dataPath;

    const luaClient = {
      getSkills: jest.fn(async () => ({
        groups: [
          { gems: [{ name: 'Determination' }, { name: 'Anger' }] },
        ],
      })),
    };

    const result = await handleSuggestWatchersEye(makeContext(luaClient));
    const text = result.content[0].text;

    expect(text).toContain(`Data source: ${dataPath}`);
    expect(text).toContain('+(600-1000) to Armour while affected by Determination');
    expect(text).toContain('Damage Penetrates (10-15)% Fire Resistance while affected by Anger');
    expect(text).not.toContain('Armour applies to Chaos Damage taken while affected by Determination');
    expect(text).not.toContain('Always Scorch while affected by Anger');
  });
});
