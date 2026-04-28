// Synthetic smoke test for analyze_build_cluster_jewels notable parsing.
//
// This intentionally avoids personal/private builds. It verifies the compiled
// handler against representative Lua get_items output.
//
// Usage:
//   npm run smoke:cluster-jewels

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const handlerPath = resolve('build/handlers/clusterJewelHandlers.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('  PASS:', message);
}

function assertIncludes(text, expected) {
  assert(text.includes(expected), `output includes: ${expected}`);
}

function assertExcludes(text, unexpected) {
  assert(!text.includes(unexpected), `output excludes: ${unexpected}`);
}

if (!existsSync(handlerPath)) {
  throw new Error(`Compiled handler not found at ${handlerPath}. Run npm run build first.`);
}

const { handleAnalyzeBuildClusterJewels } = await import(pathToFileURL(handlerPath).href);

const context = {
  ensureLuaClient: async () => {},
  getLuaClient: () => ({
    getItems: async () => [
      {
        slot: 'Jewel 7960',
        name: 'Ghoul Vessel',
        base: 'Large Cluster Jewel',
        baseName: 'Large Cluster Jewel',
        raw: [
          'Rarity: Rare',
          'Ghoul Vessel',
          'Large Cluster Jewel',
          'Adds 8 Passive Skills',
          '2 Added Passive Skills are Jewel Sockets',
          'Added Small Passive Skills grant: Wand Attacks deal 12% increased Damage with Hits and Ailments',
          '1 Added Passive Skill is Martial Prowess',
          '1 Added Passive Skill is Opportunistic Fusilade',
          "1 Added Passive Skill is Storm's Hand",
        ].join('\n'),
      },
      {
        slot: 'Jewel 29712',
        name: 'Sol Hope',
        base: 'Medium Cluster Jewel',
        raw: [
          'Rarity: Rare',
          'Sol Hope',
          'Medium Cluster Jewel',
          'Adds 5 Passive Skills',
          '1 Added Passive Skill is a Jewel Socket',
          'Added Small Passive Skills grant: 12% increased Totem Damage',
          '1 Added Passive Skill is Sleepless Sentries',
          '1 Added Passive Skill is Snaring Spirits',
        ].join('\n'),
      },
    ],
    getSkills: async () => ({
      groups: [
        {
          gems: [
            { name: 'Ball Lightning' },
          ],
        },
      ],
    }),
  }),
};

const result = await handleAnalyzeBuildClusterJewels(context);
const text = result?.content?.[0]?.text || '';

console.log('[smoke] analyze_build_cluster_jewels synthetic output:\n');
console.log(text);

assertIncludes(text, '### Ghoul Vessel (Jewel 7960)');
assertIncludes(text, '### Sol Hope (Jewel 29712)');
assertIncludes(text, 'Martial Prowess [attack, accuracy]');
assertIncludes(text, 'Opportunistic Fusilade [unclassified]');
assertIncludes(text, "Storm's Hand [unclassified]");
assertIncludes(text, 'Sleepless Sentries [unclassified]');
assertIncludes(text, 'Snaring Spirits [unclassified]');
assertExcludes(text, 'a Jewel Socket [unclassified]');
assertExcludes(text, 'Could not parse notables');

console.log('\nAll cluster jewel notable smoke checks passed.');
