import { describe, expect, it, jest } from '@jest/globals';
import { PoBLuaApiClient } from '../../src/pobLuaBridge.js';

describe('PoBLuaApiClient.powerReport', () => {
  it('sends the power_report action with params', async () => {
    const client = new PoBLuaApiClient();
    const send = jest.fn(async () => ({
      ok: true,
      result: {
        metric: { input: 'life', stat: 'Life', label: 'Life' },
        rows: [{ id: 123, name: 'Heart of Oak' }],
      },
    }));
    (client as any).send = send;

    const result = await client.powerReport({
      metric: 'life',
      scope: 'unallocated',
      includeClusterCandidates: false,
      limit: 5,
    });

    expect(send).toHaveBeenCalledWith({
      action: 'power_report',
      params: {
        metric: 'life',
        scope: 'unallocated',
        includeClusterCandidates: false,
        limit: 5,
      },
    });
    expect(result.metric?.stat).toBe('Life');
    expect(result.rows?.[0]?.name).toBe('Heart of Oak');
  });

  it('throws bridge errors', async () => {
    const client = new PoBLuaApiClient();
    (client as any).send = jest.fn(async () => ({
      ok: false,
      error: 'build not initialized',
    }));

    await expect(client.powerReport()).rejects.toThrow('build not initialized');
  });
});
