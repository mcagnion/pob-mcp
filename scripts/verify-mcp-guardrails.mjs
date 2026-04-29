#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const unitGuardrailTests = [
  'tests/unit/chargeEconomyHandlers.test.ts',
  'tests/unit/clusterJewelHandlers.test.ts',
  'tests/unit/configHandlers.test.ts',
  'tests/unit/gemFeasibilityGuardrails.test.ts',
  'tests/unit/gemQualityFreshness.test.ts',
  'tests/unit/gemQualityValidation.test.ts',
  'tests/unit/itemShoppingHandler.test.ts',
  'tests/unit/itemSkillHandlers.test.ts',
  'tests/unit/jewelAdvisorHandlers.test.ts',
  'tests/unit/luaHandlers.test.ts',
  'tests/unit/marketFreshnessGuardrails.test.ts',
  'tests/unit/mechanicsFreshness.test.ts',
  'tests/unit/optimizationHandlers.test.ts',
  'tests/unit/passiveUpgradesGuardrail.test.ts',
  'tests/unit/searchTreeAllocationGuardrail.test.ts',
  'tests/unit/statusHandlers.test.ts',
  'tests/unit/treeHandlers.test.ts',
  'tests/unit/toolSchemas.test.ts',
  'tests/unit/tradeHandlers.test.ts',
  'tests/unit/updateTreeDeltaGuardrail.test.ts',
  'tests/unit/updateTreeDeltaPreview.test.ts',
  'tests/unit/weightedTradeHandlers.test.ts',
];

const syntheticSmokes = [
  'tests/smoke/cluster-jewel-notables.smoke.mjs',
];

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function quoteWindowsArg(arg) {
  const text = String(arg);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '\\"')}"`;
}

function run(command, args, options = {}) {
  console.log(`\n[verify] ${command} ${args.join(' ')}`);
  const spawnCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : command;
  const spawnArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', [command, ...args].map(quoteWindowsArg).join(' ')]
    : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      TMPDIR: process.env.TMPDIR || '/tmp',
      TEMP: process.env.TEMP || '/tmp',
      TMP: process.env.TMP || '/tmp',
      ...options.env,
    },
  });

  if (result.error) {
    console.error(`[verify] Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const presentUnitTests = unitGuardrailTests.filter(existsSync);
const presentSmokes = syntheticSmokes.filter(existsSync);

console.log('[verify] MCP guardrail validation');
console.log(`[verify] Unit guardrail suites found: ${presentUnitTests.length}/${unitGuardrailTests.length}`);
for (const test of presentUnitTests) console.log(`  - ${test}`);
console.log(`[verify] Synthetic smokes found: ${presentSmokes.length}/${syntheticSmokes.length}`);
for (const smoke of presentSmokes) console.log(`  - ${smoke}`);

run(npmCmd, ['run', 'build']);

if (presentUnitTests.length > 0) {
  run(npxCmd, ['jest', ...presentUnitTests, '--runInBand']);
} else {
  console.log('\n[verify] No guardrail unit tests found in this checkout; skipping Jest step.');
}

for (const smoke of presentSmokes) {
  run('node', [smoke]);
}

console.log('\n[verify] MCP guardrail validation passed.');
