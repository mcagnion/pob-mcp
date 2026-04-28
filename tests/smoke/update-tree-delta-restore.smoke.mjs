// Runtime smoke test for update_tree_delta restore-after preview.
//
// Requires:
//   POB_FORK_PATH or SMOKE_POB_FORK - path to PathOfBuilding/src, or to a
//                                     PathOfBuilding checkout containing src/
//   luajit on PATH
//
// Usage:
//   POB_FORK_PATH=/path/to/PathOfBuilding/src \
//     node tests/smoke/update-tree-delta-restore.smoke.mjs [build.xml]

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PoBLuaApiClient } from '../../build/pobLuaBridge.js';

function resolvePobSrc(rawPath) {
  if (!rawPath) {
    throw new Error('Set POB_FORK_PATH or SMOKE_POB_FORK to a PathOfBuilding/src path.');
  }
  const path = resolve(rawPath);
  if (existsSync(join(path, 'HeadlessWrapper.lua'))) return path;
  const srcPath = join(path, 'src');
  if (existsSync(join(srcPath, 'HeadlessWrapper.lua'))) return srcPath;
  throw new Error(`Could not find HeadlessWrapper.lua under ${path} or ${srcPath}`);
}

function normalizeNodeList(nodes) {
  if (!Array.isArray(nodes)) return [];
  return [...new Set(nodes.map(Number).filter((node) => Number.isInteger(node) && node > 0))]
    .sort((a, b) => a - b);
}

function normalizeMasteryEffects(effects) {
  const out = {};
  if (!effects || typeof effects !== 'object') return out;
  for (const key of Object.keys(effects).sort()) {
    out[String(key)] = Number(effects[key]);
  }
  return out;
}

function normalizeTree(tree) {
  return {
    treeVersion: tree?.treeVersion == null ? '' : String(tree.treeVersion),
    classId: Number(tree?.classId ?? 0),
    ascendClassId: Number(tree?.ascendClassId ?? 0),
    secondaryAscendClassId: Number(tree?.secondaryAscendClassId ?? 0),
    nodes: normalizeNodeList(tree?.nodes),
    masteryEffects: normalizeMasteryEffects(tree?.masteryEffects),
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sameTree(left, right) {
  return stableJson(normalizeTree(left)) === stableJson(normalizeTree(right));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('  PASS:', message);
}

async function previewAndVerifyRestore(client, before, removeNodes) {
  const result = await client.updateTreeDelta({
    removeNodes,
    restoreAfter: true,
  });
  assert(result.restored === true, `update_tree_delta reported restored=true for ${removeNodes.length} removed node(s)`);
  assert(sameTree(result.restoredTree, before), 'restoredTree matches original tree');

  const after = normalizeTree(await client.getTree());
  assert(sameTree(after, before), 'live tree after preview matches original tree');

  return normalizeTree(result.tree);
}

const pobSrc = resolvePobSrc(process.env.SMOKE_POB_FORK || process.env.POB_FORK_PATH);
const buildPath = resolve(process.argv[2] || process.env.SMOKE_BUILD || 'example-build.xml');
if (!existsSync(buildPath)) {
  throw new Error(`Build XML not found: ${buildPath}`);
}

const client = new PoBLuaApiClient({
  cwd: pobSrc,
  cmd: process.env.POB_CMD || 'luajit',
  timeoutMs: Number(process.env.POB_TIMEOUT_MS || 30000),
});

try {
  console.log('[smoke] Starting bridge...');
  await client.start();

  console.log('[smoke] Loading build:', buildPath);
  await client.loadBuildXml(readFileSync(buildPath, 'utf8'), 'update-tree-delta-restore-smoke');

  const before = normalizeTree(await client.getTree());
  assert(before.nodes.length > 1, `loaded build has allocated passive nodes (${before.nodes.length})`);

  let foundDistinctPreview = false;
  const candidateRemovals = before.nodes.slice(0, 20).map((node) => [node]);
  candidateRemovals.push(before.nodes);

  for (const removeNodes of candidateRemovals) {
    console.log(`[smoke] Previewing removal of ${removeNodes.length} node(s)...`);
    const preview = await previewAndVerifyRestore(client, before, removeNodes);
    if (!sameTree(preview, before)) {
      foundDistinctPreview = true;
      console.log(`  PASS: preview tree differs from original tree (${preview.nodes.length} vs ${before.nodes.length} nodes)`);
      break;
    }
  }

  assert(
    foundDistinctPreview,
    'at least one preview changed the tree; use a fuller build via SMOKE_BUILD or argv if this fails'
  );

  console.log('\nAll update_tree_delta restore smoke checks passed.');
} finally {
  console.log('[smoke] Stopping bridge...');
  try { await client.stop(); } catch {}
}
