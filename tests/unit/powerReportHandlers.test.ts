import { describe, expect, it, jest } from '@jest/globals';
import { handlePowerReport } from '../../src/handlers/luaHandlers.js';
import { getLuaToolSchemas, getOptimizationToolSchemas } from '../../src/server/toolSchemas.js';
import { routeToolCall } from '../../src/server/toolRouter.js';

const sampleReport = {
  metric: { input: 'life', stat: 'Life', label: 'Life' },
  buildName: 'Test Build',
  scope: 'unallocated' as const,
  limit: 2,
  requestedLimit: 2,
  includeClusterCandidates: false,
  evaluated: 1,
  returned: 1,
  totalRows: 3,
  configHash: 'abc12345',
  calculation: { iterations: 4, elapsedMs: 25 },
  stateRestored: true,
  allocatedNodeSetRestored: true,
  warnings: ['limit clamped to maximum of 100'],
  rows: [
    {
      id: 123,
      name: 'Heart of Oak',
      type: 'Notable',
      allocated: false,
      power: 120,
      pathPower: 40,
      powerStr: '+120',
      pathPowerStr: '+40',
      pathDist: 3,
      interpretation: 'gain_if_allocated',
    },
  ],
};

function makeLuaContext(luaClient: any) {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: () => luaClient,
    ensureLuaClient: jest.fn(async () => {}),
    stopLuaClient: jest.fn(async () => {}),
  };
}

function makeRouterDeps(luaContext: any) {
  return {
    toolGate: { checkGate: jest.fn() },
    contextBuilder: {
      buildHandlerContext: jest.fn(() => ({})),
      buildWatchContext: jest.fn(() => ({})),
      buildTreeContext: jest.fn(() => ({})),
      buildLuaContext: jest.fn(() => luaContext),
      buildItemSkillContext: jest.fn(() => ({})),
      buildOptimizationContext: jest.fn(() => ({})),
      buildExportContext: jest.fn(() => ({})),
      buildSkillGemContext: jest.fn(() => ({})),
    },
    tradeClient: null,
    statMapper: null,
    recommendationEngine: null,
    ninjaClient: {},
    getLuaClient: luaContext.getLuaClient,
    ensureLuaClient: luaContext.ensureLuaClient,
  } as any;
}

describe('power_report tool', () => {
  it('formats PoB Power Report output with metadata and caveat', async () => {
    const luaClient = { powerReport: jest.fn(async () => sampleReport) };
    const result = await handlePowerReport(makeLuaContext(luaClient) as any, 'life', 'unallocated', false, 2);

    expect(luaClient.powerReport).toHaveBeenCalledWith({
      metric: 'life',
      scope: 'unallocated',
      includeClusterCandidates: false,
      limit: 2,
    });
    const text = result.content[0].text;
    expect(text).toContain('=== PoB Power Report ===');
    expect(text).toContain('Metric: Life');
    expect(text).toContain('Config hash: abc12345');
    expect(text).toContain('Heart of Oak [123]');
    expect(text).not.toContain('raw 120.00');
    expect(text).toContain('does not path-search or optimize multi-step allocations');
  });

  it('fails clearly when the Lua client is missing', async () => {
    await expect(handlePowerReport(makeLuaContext(null) as any)).rejects.toThrow(
      'Failed to generate power report: Lua client not initialized'
    );
  });

  it('propagates bridge abort errors', async () => {
    const errorMessage = 'power report timed out after 100000 iterations and 5000 ms; stillRunning=true; metric=Life';
    const luaClient = { powerReport: jest.fn(async () => { throw new Error(errorMessage); }) };

    await expect(handlePowerReport(makeLuaContext(luaClient) as any, 'life')).rejects.toThrow(
      `Failed to generate power report: ${errorMessage}`
    );
  });

  it('registers the Lua schema and distinguishes the optimizer schema', () => {
    const powerSchema = getLuaToolSchemas().find((schema) => schema.name === 'power_report');
    expect(powerSchema).toBeDefined();
    expect(powerSchema?.description).toContain('raw single-stat node rankings');
    expect(powerSchema?.inputSchema.properties.scope.default).toBe('unallocated');
    expect(powerSchema?.inputSchema.properties.include_cluster_candidates.default).toBe(true);
    expect(powerSchema?.inputSchema.properties.limit.default).toBe(20);

    const optimizerSchema = getOptimizationToolSchemas().find((schema) => schema.name === 'suggest_optimal_nodes');
    expect(optimizerSchema?.description).toContain('pathing-aware');
    expect(optimizerSchema?.description).toContain('power_report');
  });

  it('routes power_report calls to the Lua handler', async () => {
    const luaClient = { powerReport: jest.fn(async () => sampleReport) };
    const luaContext = makeLuaContext(luaClient);

    const result = await routeToolCall(
      'power_report',
      { metric: 'life', scope: 'both', include_cluster_candidates: false, limit: 5 },
      makeRouterDeps(luaContext)
    );

    expect(luaClient.powerReport).toHaveBeenCalledWith({
      metric: 'life',
      scope: 'both',
      includeClusterCandidates: false,
      limit: 5,
    });
    expect(result.content[0].text).toContain('PoB Power Report');
  });
});
