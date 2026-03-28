#!/usr/bin/env node

import { loadBridgeConfig, maskBridgeConfig } from './config.js';
import { RelaycastN8nBridge } from './bridge.js';
import { transformRelaycastEvent } from './transform.js';

function usage(): string {
  return [
    'Usage:',
    '  relaycast-n8n-bridge start --config bridge.json',
    '  relaycast-n8n-bridge test --config bridge.json --route "review-*"',
    '  relaycast-n8n-bridge health --config bridge.json',
  ].join('\n');
}

function getFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function exampleChannel(pattern: string): string {
  return pattern.replace(/\*/g, 'sample').replace(/\?/g, 'x');
}

async function startCommand(args: string[]): Promise<void> {
  const configPath = getFlag(args, '--config');
  const config = await loadBridgeConfig(configPath ? { configPath } : {});
  const bridge = new RelaycastN8nBridge(config);
  await bridge.start();

  console.log(
    JSON.stringify(
      {
        status: 'running',
        config: maskBridgeConfig(config),
        healthUrl: bridge.healthUrl,
      },
      null,
      2,
    ),
  );

  const shutdown = async (): Promise<void> => {
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise<void>(() => undefined);
}

async function testCommand(args: string[]): Promise<void> {
  const configPath = getFlag(args, '--config');
  const requestedRoute = getFlag(args, '--route');
  const config = await loadBridgeConfig(configPath ? { configPath } : {});
  const selectedRoutes = requestedRoute
    ? config.routes.filter(
        (route) =>
          route.id === requestedRoute || route.channelPattern === requestedRoute,
      )
    : config.routes;

  if (selectedRoutes.length === 0) {
    throw new Error(`No routes matched "${requestedRoute}".`);
  }

  const firstRoute = selectedRoutes[0];
  if (!firstRoute) {
    throw new Error('At least one route is required.');
  }
  const sampleEvent = {
    type: 'message.created' as const,
    channel: exampleChannel(firstRoute.channelPattern),
    message: {
      id: 'sample-message',
      agentId: 'sample-agent-id',
      agentName: 'reviewer-bot',
      text: 'High severity finding in src/api.ts for PR #42',
      attachments: [],
    },
  };

  const samplePayload = transformRelaycastEvent({
    event: sampleEvent,
    bridgeId: config.bridgeId,
    routeId: firstRoute.id,
    processedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  });

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        config: maskBridgeConfig(config),
        selectedRoutes,
        samplePayload,
      },
      null,
      2,
    ),
  );
}

async function healthCommand(args: string[]): Promise<void> {
  const explicitUrl = getFlag(args, '--url');
  const configPath = getFlag(args, '--config');
  let url = explicitUrl;

  if (!url) {
    const config = await loadBridgeConfig(configPath ? { configPath } : {});
    const host = config.healthHost === '0.0.0.0' ? '127.0.0.1' : config.healthHost;
    url = `http://${host}:${config.healthPort}/health`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }

  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }

  if (command === 'start') {
    await startCommand(args);
    return;
  }

  if (command === 'test') {
    await testCommand(args);
    return;
  }

  if (command === 'health') {
    await healthCommand(args);
    return;
  }

  throw new Error(`Unknown command "${command}".\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
