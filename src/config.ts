import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const routeFilterSchema = z.object({
  senders: z.array(z.string().min(1)).min(1).optional(),
  contentMatch: z.string().min(1).optional(),
});

const routeSchema = z.object({
  id: z.string().min(1).optional(),
  channelPattern: z.string().min(1),
  n8nWebhookUrl: z.url(),
  filter: routeFilterSchema.optional(),
});

const bridgeConfigInputSchema = z.object({
  bridgeId: z.string().min(1).optional(),
  relaycastUrl: z.url().optional(),
  relayfileUrl: z.url().optional(),
  relaycastToken: z.string().min(1).optional(),
  relayfileToken: z.string().min(1).optional(),
  routes: z.array(routeSchema).min(1).optional(),
  batchWindowMs: z.coerce.number().int().min(1).optional(),
  webhookTimeoutMs: z.coerce.number().int().min(1).optional(),
  retryAttempts: z.coerce.number().int().min(1).max(10).optional(),
  retryBaseDelayMs: z.coerce.number().int().min(1).optional(),
  deadLetterPath: z.string().min(1).optional(),
  healthHost: z.string().min(1).optional(),
  healthPort: z.coerce.number().int().min(0).max(65535).optional(),
  maxReconnectAttempts: z.coerce.number().int().min(0).optional(),
  reconnectBaseDelayMs: z.coerce.number().int().min(1).optional(),
  reconnectMaxDelayMs: z.coerce.number().int().min(1).optional(),
  debug: z.boolean().optional(),
});

const bridgeConfigSchema = z.object({
  bridgeId: z.string().min(1),
  relaycastUrl: z.url(),
  relaycastToken: z.string().min(1),
  routes: z.array(routeSchema.extend({ id: z.string().min(1) })).min(1),
  batchWindowMs: z.number().int().min(1),
  webhookTimeoutMs: z.number().int().min(1),
  retryAttempts: z.number().int().min(1).max(10),
  retryBaseDelayMs: z.number().int().min(1),
  deadLetterPath: z.string().min(1),
  healthHost: z.string().min(1),
  healthPort: z.number().int().min(0).max(65535),
  maxReconnectAttempts: z.number().int().min(0),
  reconnectBaseDelayMs: z.number().int().min(1),
  reconnectMaxDelayMs: z.number().int().min(1),
  debug: z.boolean(),
});

export type BridgeRouteFilter = z.infer<typeof routeFilterSchema>;
export type BridgeRouteConfig = z.infer<typeof routeSchema> & { id: string };
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type BridgeConfigInput = z.input<typeof bridgeConfigInputSchema>;

export interface LoadBridgeConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: BridgeConfigInput;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return /^(1|true|yes|on)$/i.test(value);
}

function parseJsonEnv<T>(value: string | undefined): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

function loadEnvConfig(env: NodeJS.ProcessEnv): BridgeConfigInput {
  const routes =
    parseJsonEnv<BridgeConfigInput['routes']>(env.BRIDGE_ROUTES_JSON) ??
    (env.N8N_WEBHOOK_URL
      ? [
          {
            channelPattern: env.N8N_CHANNEL_PATTERN ?? '*',
            n8nWebhookUrl: env.N8N_WEBHOOK_URL,
          },
        ]
      : undefined);

  return {
    bridgeId: env.BRIDGE_ID,
    relaycastUrl: env.RELAYCAST_URL ?? env.RELAYFILE_URL,
    relaycastToken: env.RELAYCAST_TOKEN ?? env.RELAYFILE_TOKEN,
    routes,
    batchWindowMs: env.BRIDGE_BATCH_WINDOW_MS,
    webhookTimeoutMs: env.BRIDGE_WEBHOOK_TIMEOUT_MS,
    retryAttempts: env.BRIDGE_RETRY_ATTEMPTS,
    retryBaseDelayMs: env.BRIDGE_RETRY_BASE_DELAY_MS,
    deadLetterPath: env.BRIDGE_DEAD_LETTER_PATH,
    healthHost: env.BRIDGE_HEALTH_HOST,
    healthPort: env.BRIDGE_HEALTH_PORT,
    maxReconnectAttempts: env.BRIDGE_MAX_RECONNECT_ATTEMPTS,
    reconnectBaseDelayMs: env.BRIDGE_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: env.BRIDGE_RECONNECT_MAX_DELAY_MS,
    debug: parseBoolean(env.BRIDGE_DEBUG),
  };
}

function mergeConfig(
  base: BridgeConfigInput | undefined,
  next: BridgeConfigInput | undefined,
): BridgeConfigInput {
  const definedEntries = Object.entries(next ?? {}).filter(([, value]) => value !== undefined);
  return {
    ...base,
    ...Object.fromEntries(definedEntries),
    routes: next?.routes ?? base?.routes,
  };
}

function withDefaults(raw: BridgeConfigInput, baseDir: string): BridgeConfig {
  const parsed = bridgeConfigInputSchema.parse(raw);
  const relaycastUrl = parsed.relaycastUrl ?? parsed.relayfileUrl ?? 'https://api.relaycast.dev';
  const relaycastToken = parsed.relaycastToken ?? parsed.relayfileToken;

  if (!relaycastToken) {
    throw new Error('Missing relaycast token. Set relaycastToken, relayfileToken, RELAYCAST_TOKEN, or RELAYFILE_TOKEN.');
  }

  const routes = (parsed.routes ?? []).map((route, index) => ({
    ...route,
    id: route.id ?? `route-${index + 1}`,
  }));

  return bridgeConfigSchema.parse({
    bridgeId: parsed.bridgeId ?? `relaycast-n8n-bridge-${randomUUID()}`,
    relaycastUrl,
    relaycastToken,
    routes,
    batchWindowMs: parsed.batchWindowMs ?? 100,
    webhookTimeoutMs: parsed.webhookTimeoutMs ?? 10_000,
    retryAttempts: parsed.retryAttempts ?? 3,
    retryBaseDelayMs: parsed.retryBaseDelayMs ?? 500,
    deadLetterPath: resolve(baseDir, parsed.deadLetterPath ?? '.data/relaycast-n8n-bridge.dead-letter.jsonl'),
    healthHost: parsed.healthHost ?? '127.0.0.1',
    healthPort: parsed.healthPort ?? 8787,
    maxReconnectAttempts: parsed.maxReconnectAttempts ?? 50,
    reconnectBaseDelayMs: parsed.reconnectBaseDelayMs ?? 1_000,
    reconnectMaxDelayMs: parsed.reconnectMaxDelayMs ?? 30_000,
    debug: parsed.debug ?? false,
  });
}

export async function loadBridgeConfig(
  options: LoadBridgeConfigOptions = {},
): Promise<BridgeConfig> {
  const envConfig = loadEnvConfig(options.env ?? process.env);
  let fileConfig: BridgeConfigInput | undefined;
  let baseDir = process.cwd();

  if (options.configPath) {
    const configPath = resolve(options.configPath);
    baseDir = dirname(configPath);
    const contents = await readFile(configPath, 'utf8');
    fileConfig = JSON.parse(contents) as BridgeConfigInput;
  }

  const merged = mergeConfig(mergeConfig(fileConfig, envConfig), options.overrides);
  return withDefaults(merged, baseDir);
}

export function maskBridgeConfig(config: BridgeConfig): Omit<BridgeConfig, 'relaycastToken'> & {
  relaycastToken: string;
} {
  const token =
    config.relaycastToken.length <= 8
      ? '********'
      : `${config.relaycastToken.slice(0, 4)}...${config.relaycastToken.slice(-4)}`;

  return {
    ...config,
    relaycastToken: token,
  };
}
