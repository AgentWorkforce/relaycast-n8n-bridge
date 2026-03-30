import test from 'node:test';
import assert from 'node:assert/strict';
import { transformRelaycastEvent } from '../dist/transform.js';

test('transformRelaycastEvent extracts structured metadata', () => {
  const payload = transformRelaycastEvent({
    event: {
      type: 'message.created',
      channel: 'review-api',
      message: {
        id: 'm-1',
        agentId: 'a-1',
        agentName: 'reviewer-bot',
        text: 'High severity issue in src/api.ts for PR #42',
        attachments: [],
      },
    },
    bridgeId: 'bridge-1',
    routeId: 'route-1',
    processedAt: '2026-03-28T10:00:00.000Z',
    receivedAt: '2026-03-28T10:00:00.000Z',
  });

  assert.equal(payload.source, 'relaycast');
  assert.equal(payload.metadata.prNumber, 42);
  assert.equal(payload.metadata.severity, 'high');
  assert.deepEqual(payload.metadata.filePaths, ['src/api.ts']);
  assert.equal(payload.metadata.agentRole, 'reviewer');
});
