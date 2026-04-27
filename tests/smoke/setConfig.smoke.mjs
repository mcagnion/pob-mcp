// Runtime smoke test for set_config.
// Spawns the real Lua bridge, loads a build, and asserts the new
// appliedKeys/aliasedKeys/ignoredKeys contract.

import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Resolve POB_FORK_PATH and a build XML to load. Order of precedence:
//   1. SMOKE_POB_FORK / SMOKE_BUILD env vars (CI / one-off override)
//   2. POB_FORK_PATH / POB_DIRECTORY env vars (already exported when running
//      under the MCP server)
//   3. .mcp.json at the repo root (the canonical local config; gitignored
//      per .claude/check-pob-context.local.sh)
function resolveConfig() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let mcpForkPath = '';
  let mcpBuildsDir = '';
  const mcpFile = join(repoRoot, '.mcp.json');
  if (existsSync(mcpFile)) {
    try {
      const json = JSON.parse(readFileSync(mcpFile, 'utf8'));
      const env = json?.mcpServers?.pob?.env || {};
      mcpForkPath = env.POB_FORK_PATH || '';
      mcpBuildsDir = env.POB_DIRECTORY || '';
    } catch (e) {
      console.warn(`Could not parse ${mcpFile}: ${e.message}`);
    }
  }
  const forkPath =
    process.env.SMOKE_POB_FORK || process.env.POB_FORK_PATH || mcpForkPath;
  if (!forkPath) {
    throw new Error(
      'Could not resolve POB_FORK_PATH. Set SMOKE_POB_FORK or POB_FORK_PATH, ' +
      'or configure .mcp.json with mcpServers.pob.env.POB_FORK_PATH.'
    );
  }
  let buildPath = process.env.SMOKE_BUILD || '';
  if (!buildPath) {
    const buildsDir = mcpBuildsDir || join(forkPath, 'Builds');
    if (!existsSync(buildsDir)) {
      throw new Error(
        `Builds directory not found: ${buildsDir}. ` +
        'Set SMOKE_BUILD to a specific .xml path.'
      );
    }
    const xmls = readdirSync(buildsDir).filter(f => f.toLowerCase().endsWith('.xml'));
    if (xmls.length === 0) {
      throw new Error(
        `No .xml builds in ${buildsDir}. Set SMOKE_BUILD to a specific .xml path.`
      );
    }
    buildPath = join(buildsDir, xmls[0]);
  }
  return { forkPath, buildPath };
}

const { forkPath: POB_FORK, buildPath: BUILD_PATH } = resolveConfig();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    failures++;
    console.error('  FAIL:', msg);
  }
}

const client = new PoBLuaApiClient({
  cwd: POB_FORK,
  cmd: 'luajit',
  timeoutMs: 30000,
});

try {
  console.log('Starting bridge...');
  await client.start();
  console.log('Loading build:', BUILD_PATH);
  const xml = readFileSync(BUILD_PATH, 'utf-8');
  await client.loadBuildXml(xml);

  // 1. Legacy phantom key (was silently writing to a non-existent var in the old whitelist)
  console.log('\n[1] set_config({conditionFortify: true}) - legacy alias');
  let r = await client.setConfig({ conditionFortify: true });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys, 'aliasedKeys:', r.aliasedKeys);
  assert(r.appliedKeys.includes('buffFortification'), 'conditionFortify aliased to buffFortification (real PoB var)');
  assert(r.aliasedKeys.conditionFortify === 'buffFortification', 'alias surfaced in aliasedKeys');

  // 2. The whole point: a key OUTSIDE the old whitelist
  console.log('\n[2] set_config({conditionEnemyBurning: true})');
  r = await client.setConfig({ conditionEnemyBurning: true });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys, 'aliasedKeys:', r.aliasedKeys);
  assert(r.appliedKeys.includes('conditionEnemyBurning'), 'conditionEnemyBurning applied (was silently ignored before fix)');
  assert(r.ignoredKeys.length === 0, 'no ignored keys');

  // 3. Garbage key -> ignored
  console.log('\n[3] set_config({totallyBogusKey: 42})');
  r = await client.setConfig({ totallyBogusKey: 42 });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys, 'aliasedKeys:', r.aliasedKeys);
  assert(r.ignoredKeys.includes('totallyBogusKey'), 'unknown key surfaced in ignoredKeys');
  assert(r.appliedKeys.length === 0, 'no keys applied');

  // 4. Resistance with the (incorrect-but-historical) long form -> aliased to short canonical
  console.log('\n[4] set_config({enemyFireResistance: 80})');
  r = await client.setConfig({ enemyFireResistance: 80 });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys, 'aliasedKeys:', r.aliasedKeys);
  assert(r.appliedKeys.includes('enemyFireResist'), 'enemyFireResistance aliased to enemyFireResist');
  assert(r.aliasedKeys.enemyFireResistance === 'enemyFireResist', 'aliasedKeys map populated');

  // 5. Resistance with the canonical short form
  console.log('\n[5] set_config({enemyFireResist: 60})');
  r = await client.setConfig({ enemyFireResist: 60 });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys, 'aliasedKeys:', r.aliasedKeys);
  assert(r.appliedKeys.includes('enemyFireResist'), 'enemyFireResist applied directly');
  assert(Object.keys(r.aliasedKeys).length === 0, 'no alias when canonical name used');

  // 6. Mix of valid + ignored, also exercises bool coercion
  console.log('\n[6] set_config({usePowerCharges: true, garbage1: "x", buffOnslaught: true, garbage2: 0})');
  r = await client.setConfig({ usePowerCharges: true, garbage1: 'x', buffOnslaught: true, garbage2: 0 });
  console.log('   appliedKeys:', r.appliedKeys, 'ignoredKeys:', r.ignoredKeys);
  assert(r.appliedKeys.includes('usePowerCharges') && r.appliedKeys.includes('buffOnslaught'), 'both valid keys applied');
  assert(r.ignoredKeys.includes('garbage1') && r.ignoredKeys.includes('garbage2'), 'both garbage keys ignored');

  // 7. Verify get_config reflects what we wrote
  console.log('\n[7] get_config after the set_config calls');
  const cfg = await client.getConfig();
  console.log('   bandit/pantheon/enemyLevel snapshot:', JSON.stringify({
    enemyLevel: cfg.enemyLevel,
  }));
  // Note: get_config currently only surfaces a tiny subset, that's a separate issue.

} catch (e) {
  failures++;
  console.error('\nUnhandled error:', e?.stack || e);
} finally {
  console.log('\nStopping bridge...');
  try { await client.stop(); } catch {}
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
