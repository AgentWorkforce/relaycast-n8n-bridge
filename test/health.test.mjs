import test from 'node:test';
import assert from 'node:assert/strict';
import { startHealthServer } from '../dist/health.js';

test('startHealthServer serves the current snapshot on /health', async () => {
  const server = await startHealthServer({
    host: '127.0.0.1',
    port: 0,
    getSnapshot: () => ({
      status: 'running',
      bridgeId: 'bridge-1',
      startedAt: '2026-03-28T10:00:00.000Z',
      queueDepth: 2,
      subscribedChannels: ['review-123'],
      metrics: { messagesForwarded: 5 },
    }),
  });

  const response = await fetch(server.url);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.bridgeId, 'bridge-1');
  assert.equal(payload.status, 'running');
  assert.deepEqual(payload.subscribedChannels, ['review-123']);

  await server.close();
});
