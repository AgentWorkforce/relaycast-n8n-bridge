import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RelaycastN8nBridge } from '../dist/bridge.js';

class FakeWsClient {
  handlers = new Map();
  subscriptions = [];

  connect() {
    this.emit('open', { type: 'open' });
  }

  disconnect() {}

  subscribe(channels) {
    this.subscriptions.push([...channels]);
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
    this.handlers.get('*')?.forEach((handler) => handler(payload));
  }
}

function createFakeRelay(messages = {}) {
  return {
    channels: {
      async list() {
        return [{ name: 'review-123' }];
      },
    },
    messages: {
      async get(id) {
        const message = messages[id] ?? {
          id,
          text: 'High severity issue in src/index.ts for PR #42',
          createdAt: '2026-03-28T12:00:00.000Z',
        };

        return {
          id: message.id,
          channelId: 'ch-1',
          agentId: 'agt-1',
          agentName: 'reviewer-bot',
          text: message.text,
          blocks: null,
          metadata: null,
          hasAttachments: false,
          threadId: null,
          attachments: [],
          createdAt: message.createdAt,
          replyCount: 0,
          reactions: [],
          readByCount: 0,
        };
      },
    },
  };
}

test('bridge batches queued events before forwarding', async () => {
  const ws = new FakeWsClient();
  const fetchCalls = [];

  const bridge = new RelaycastN8nBridge(
    {
      bridgeId: 'bridge-1',
      relaycastUrl: 'https://api.relaycast.dev',
      relaycastToken: 'token',
      routes: [
        {
          id: 'route-1',
          channelPattern: 'review-*',
          n8nWebhookUrl: 'https://n8n.example/webhook/reviews',
        },
      ],
      batchWindowMs: 50,
      webhookTimeoutMs: 1_000,
      retryAttempts: 3,
      retryBaseDelayMs: 10,
      deadLetterPath: join(tmpdir(), 'unused-dead-letter.jsonl'),
      healthHost: '127.0.0.1',
      healthPort: 0,
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 100,
      debug: false,
    },
    {
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return new Response('', { status: 200 });
      },
      createWsClient: () => ws,
      createRelayCast: () =>
        createFakeRelay({
          'm-1': {
            id: 'm-1',
            text: 'High severity issue in src/index.ts for PR #42',
            createdAt: '2026-03-28T12:00:00.000Z',
          },
          'm-2': {
            id: 'm-2',
            text: 'Low severity issue in src/worker.ts for PR #42',
            createdAt: '2026-03-28T12:00:05.000Z',
          },
        }),
    },
  );

  await bridge.start();

  ws.emit('message.created', {
    type: 'message.created',
    channel: 'review-123',
    message: {
      id: 'm-1',
      agentId: 'agt-1',
      agentName: 'reviewer-bot',
      text: 'High severity issue in src/index.ts for PR #42',
      attachments: [],
    },
  });
  ws.emit('message.created', {
    type: 'message.created',
    channel: 'review-123',
    message: {
      id: 'm-2',
      agentId: 'agt-1',
      agentName: 'reviewer-bot',
      text: 'Low severity issue in src/worker.ts for PR #42',
      attachments: [],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  const health = bridge.getHealthSnapshot();
  assert.equal(fetchCalls.length, 2);
  assert.equal(health.metrics.batchesProcessed, 1);

  await bridge.stop();
});

test('bridge dead-letters failed forwards after retries', async () => {
  const ws = new FakeWsClient();
  const tempDir = await mkdtemp(join(tmpdir(), 'relaycast-n8n-bridge-'));
  const deadLetterPath = join(tempDir, 'dead-letter.jsonl');

  const bridge = new RelaycastN8nBridge(
    {
      bridgeId: 'bridge-2',
      relaycastUrl: 'https://api.relaycast.dev',
      relaycastToken: 'token',
      routes: [
        {
          id: 'route-1',
          channelPattern: 'review-*',
          n8nWebhookUrl: 'https://n8n.example/webhook/reviews',
        },
      ],
      batchWindowMs: 20,
      webhookTimeoutMs: 100,
      retryAttempts: 3,
      retryBaseDelayMs: 5,
      deadLetterPath,
      healthHost: '127.0.0.1',
      healthPort: 0,
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 100,
      debug: false,
    },
    {
      fetchImpl: async () => new Response('boom', { status: 500 }),
      createWsClient: () => ws,
      createRelayCast: () =>
        createFakeRelay({
          'm-fail': {
            id: 'm-fail',
            text: 'Critical issue in src/index.ts for PR #99',
            createdAt: '2026-03-28T12:10:00.000Z',
          },
        }),
    },
  );

  await bridge.start();
  ws.emit('message.created', {
    type: 'message.created',
    channel: 'review-123',
    message: {
      id: 'm-fail',
      agentId: 'agt-1',
      agentName: 'reviewer-bot',
      text: 'Critical issue in src/index.ts for PR #99',
      attachments: [],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  await bridge.stop();

  const contents = await readFile(deadLetterPath, 'utf8');
  assert.match(contents, /"routeId":"route-1"/);
  assert.match(contents, /"Critical issue in src\/index.ts for PR #99"/);

  await rm(tempDir, { recursive: true, force: true });
});
