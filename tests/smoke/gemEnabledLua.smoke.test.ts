import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFile } from 'fs/promises';
import { PoBLuaApiClient } from '../../src/pobLuaBridge.js';

const runSmoke = process.env.POB_MCP_RUN_LUA_SMOKE === '1';
const describeSmoke = runSmoke ? describe : describe.skip;

describeSmoke('Lua gem enabled smoke', () => {
  let client: PoBLuaApiClient;

  beforeAll(async () => {
    const pobForkPath = process.env.POB_FORK_PATH;
    const buildXmlPath = process.env.POB_MCP_SMOKE_BUILD_XML;
    if (!pobForkPath || !buildXmlPath) {
      throw new Error('Set POB_FORK_PATH and POB_MCP_SMOKE_BUILD_XML to run this smoke.');
    }

    client = new PoBLuaApiClient({ cwd: pobForkPath });
    await client.start();
    const xml = await readFile(buildXmlPath, 'utf-8');
    await client.loadBuildXml(xml, 'smoke-build');
  });

  afterAll(async () => {
    await client?.stop();
  });

  it('sets gem enabled state and restores it through get_skills', async () => {
    const skills = await client.getSkills();
    const group = skills.groups.find((candidate: any) => Array.isArray(candidate.gems) && candidate.gems.some((gem: any) => gem.enabled !== false));
    const gem = group?.gems.find((candidate: any) => candidate.enabled !== false);

    expect(group?.index).toBeGreaterThan(0);
    expect(gem?.index).toBeGreaterThan(0);
    const targetGroup = group!;
    const targetGem = gem!;

    try {
      await client.setGemEnabled({ groupIndex: targetGroup.index, gemIndex: targetGem.index, enabled: false });
      const disabledSkills = await client.getSkills();
      const disabledGroup = disabledSkills.groups.find((candidate: any) => candidate.index === targetGroup.index);
      const disabledGem = disabledGroup.gems.find((candidate: any) => candidate.index === targetGem.index);
      expect(disabledGem.enabled).toBe(false);
    } finally {
      await client.setGemEnabled({ groupIndex: targetGroup.index, gemIndex: targetGem.index, enabled: true });
    }

    const restoredSkills = await client.getSkills();
    const restoredGroup = restoredSkills.groups.find((candidate: any) => candidate.index === targetGroup.index);
    const restoredGem = restoredGroup.gems.find((candidate: any) => candidate.index === targetGem.index);
    expect(restoredGem.enabled).toBe(true);
  });
});
