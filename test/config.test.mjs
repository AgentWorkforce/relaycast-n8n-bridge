import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBridgeConfig } from '../dist/config.js';

test('loadBridgeConfig merges file, env, and overrides in priority order', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'relaycast-n8n-config-'));
  const configPath = join(tempDir, 'bridge.json');

  await writeFile(
    configPath,
    JSON.stringify({
      bridgeId: 'file-bridge',
      relayfileUrl: 'https://relay.example',
      relayfileToken: 'file-token',
      routes: [
        {
          channelPattern: 'review-*',
          n8nWebhookUrl: 'https://n8n.example/file',
        },
      ],
      deadLetterPath: './dead-letter.jsonl',
      healthPort: 9000,
    }),
    'utf8',
  );

  const config = await loadBridgeConfig({
    configPath,
    env: {
      RELAYCAST_TOKEN: 'env-token',
      BRIDGE_HEALTH_PORT: '9100',
    },
    overrides: {
      bridgeId: 'override-bridge',
      routes: [
        {
          id: 'override-route',
          channelPattern: 'alerts',
          n8nWebhookUrl: 'https://n8n.example/override',
        },
      ],
    },
  });

  assert.equal(config.bridgeId, 'override-bridge');
  assert.equal(config.relaycastUrl, 'https://relay.example');
  assert.equal(config.relaycastToken, 'env-token');
  assert.equal(config.healthPort, 9100);
  assert.equal(config.routes.length, 1);
  assert.equal(config.routes[0]?.id, 'override-route');
  assert.equal(config.routes[0]?.channelPattern, 'alerts');
  assert.equal(config.deadLetterPath, join(tempDir, 'dead-letter.jsonl'));

  await rm(tempDir, { recursive: true, force: true });
});

test('loadBridgeConfig supports single-route env shortcut', async () => {
  const config = await loadBridgeConfig({
    env: {
      RELAYCAST_URL: 'https://api.relaycast.dev',
      RELAYCAST_TOKEN: 'token',
      N8N_CHANNEL_PATTERN: 'security-*',
      N8N_WEBHOOK_URL: 'https://n8n.example/security',
    },
  });

  assert.equal(config.routes.length, 1);
  assert.equal(config.routes[0]?.channelPattern, 'security-*');
  assert.equal(config.routes[0]?.n8nWebhookUrl, 'https://n8n.example/security');
});
