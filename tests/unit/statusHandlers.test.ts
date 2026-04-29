import { describe, expect, it, jest } from '@jest/globals';
import { handleMcpStatus } from '../../src/handlers/statusHandlers.js';
import { getToolSchemas } from '../../src/server/toolSchemas.js';

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    serverName: 'pob-mcp-server',
    serverVersion: '1.0.0',
    startedAt: new Date('2026-04-29T10:00:00.000Z'),
    startupGitCommit: 'aaaaaaaaaaaa',
    pobDirectory: '/tmp/pob-builds',
    luaEnabled: true,
    getLuaClient: () => null,
    readCurrentGitCommit: () => 'aaaaaaaaaaaa',
    now: () => new Date('2026-04-29T10:01:05.000Z'),
    ...overrides,
  } as any;
}

describe('handleMcpStatus', () => {
  it('reports stale server code and the Lua bootstrap build', async () => {
    const luaClient = {
      isAlive: jest.fn(() => true),
      getBuildInfo: jest.fn(async () => ({
        name: 'Init Test',
        level: 1,
        className: 'Witch',
        ascendancy: '',
        treeVersion: '3_28',
      })),
    };

    const result = await handleMcpStatus(baseContext({
      getLuaClient: () => luaClient,
      readCurrentGitCommit: () => 'bbbbbbbbbbbb',
    }));
    const text = result.content[0].text;

    expect(text).toContain('=== MCP Status ===');
    expect(text).toContain('Startup git commit: aaaaaaaaaaaa');
    expect(text).toContain('Current git commit: bbbbbbbbbbbb');
    expect(text).toContain('Lua bridge: enabled, active');
    expect(text).toContain('Loaded build: Init Test');
    expect(text).toContain('Server code may be stale');
    expect(text).toContain('Lua bootstrap build (Init Test)');
    expect(text).toContain('lua_load_build');
  });

  it('warns when Lua is enabled but no client is active', async () => {
    const result = await handleMcpStatus(baseContext());
    const text = result.content[0].text;

    expect(text).toContain('Lua bridge: enabled, not started');
    expect(text).toContain('Loaded build: (none)');
    expect(text).toContain('load a build before trusting loaded-build analysis tools');
  });

  it('is exposed as a base MCP tool', () => {
    const tool = getToolSchemas().find((schema) => schema.name === 'mcp_status');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toEqual({});
    expect(tool?.description).toContain('startup/current git commit');
  });
});
