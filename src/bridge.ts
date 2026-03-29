import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  RelayCast,
  WsClient,
  type MessageCreatedEvent,
  type MessageWithMeta,
  type RelayCastOptions,
  type ThreadReplyEvent,
  type WsClientEvent,
  type WsClientOptions,
  type WsPermanentlyDisconnectedEvent,
  type WsReconnectingEvent,
} from '@relaycast/sdk';
import { minimatch } from 'minimatch';
import { WebSocket as NodeWebSocket } from 'ws';
import type { BridgeConfig, BridgeRouteConfig } from './config.js';
import { startHealthServer, type HealthServer, type HealthSnapshot } from './health.js';
import {
  isRelaycastBridgeEvent,
  transformRelaycastEvent,
  type RelaycastBridgeEvent,
  type RelaycastWebhookPayload,
} from './transform.js';

type BridgeStatus = 'starting' | 'running' | 'degraded' | 'stopped';

interface RouteMetrics {
  matched: number;
  forwarded: number;
  errors: number;
  retries: number;
  deadLettered: number;
  lastForwardedAt?: string;
  lastError?: string;
}

interface QueueItem {
  event: RelaycastBridgeEvent;
  receivedAt: string;
}

export interface BridgeWsClient {
  connect(): void;
  disconnect(): void;
  subscribe(channels: string[]): void;
  on(event: string, handler: (event: unknown) => void): () => void;
}

export interface RelayCastLike {
  channels: {
    list(options?: { includeArchived?: boolean }): Promise<Array<{ name: string }>>;
  };
  messages: {
    get(id: string): Promise<MessageWithMeta>;
  };
}

export interface BridgeDependencies {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  createWsClient?: (options: WsClientOptions) => BridgeWsClient;
  createRelayCast?: (options: RelayCastOptions) => RelayCastLike;
  createHealthServer?: typeof startHealthServer;
}

export interface BridgeMetrics {
  messagesReceived: number;
  batchesProcessed: number;
  messagesForwarded: number;
  webhookErrors: number;
  wsErrors: number;
  reconnects: number;
  permanentlyDisconnected: number;
  deadLetters: number;
  lastBatchAt?: string;
  lastForwardAt?: string;
  lastReconnectAttempt?: number;
}

export interface DeadLetterEntry {
  failedAt: string;
  routeId: string;
  channel: string;
  webhookUrl: string;
  reason: string;
  payload: RelaycastWebhookPayload;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasGlobPattern(pattern: string): boolean {
  return /[*?[\]{}()!+@]/.test(pattern);
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeContentMatcher(pattern: string): RegExp {
  const regexLiteral = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexLiteral?.[1]) {
    return new RegExp(regexLiteral[1], regexLiteral[2]);
  }

  return new RegExp(pattern, 'i');
}

function ensureWebSocketGlobal(): void {
  if (!globalThis.WebSocket) {
    globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  }
}

export class RelaycastN8nBridge {
  private readonly config: BridgeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createWsClient: (options: WsClientOptions) => BridgeWsClient;
  private readonly createRelayCast: (options: RelayCastOptions) => RelayCastLike;
  private readonly createHealthServer: typeof startHealthServer;
  private readonly startedAt: string;
  private readonly routeMetrics = new Map<string, RouteMetrics>();
  private readonly queue: QueueItem[] = [];

  private relay?: RelayCastLike;
  private ws?: BridgeWsClient;
  private healthServer?: HealthServer;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> = Promise.resolve();
  private status: BridgeStatus = 'stopped';
  private subscribedChannels: string[] = [];
  private readonly metrics: BridgeMetrics = {
    messagesReceived: 0,
    batchesProcessed: 0,
    messagesForwarded: 0,
    webhookErrors: 0,
    wsErrors: 0,
    reconnects: 0,
    permanentlyDisconnected: 0,
    deadLetters: 0,
  };

  constructor(config: BridgeConfig, dependencies: BridgeDependencies = {}) {
    this.config = config;
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.createWsClient =
      dependencies.createWsClient ??
      ((options) => new WsClient(options) as unknown as BridgeWsClient);
    this.createRelayCast =
      dependencies.createRelayCast ??
      ((options) => new RelayCast(options) as unknown as RelayCastLike);
    this.createHealthServer = dependencies.createHealthServer ?? startHealthServer;
    this.startedAt = this.now().toISOString();

    for (const route of config.routes) {
      this.routeMetrics.set(route.id, {
        matched: 0,
        forwarded: 0,
        errors: 0,
        retries: 0,
        deadLettered: 0,
      });
    }
  }

  get healthUrl(): string | undefined {
    return this.healthServer?.url;
  }

  async start(): Promise<void> {
    if (this.status !== 'stopped') {
      return;
    }

    if (!this.fetchImpl) {
      throw new Error('Fetch is not available in this runtime.');
    }

    ensureWebSocketGlobal();
    this.status = 'starting';
    this.relay = this.createRelayCast({
      apiKey: this.config.relaycastToken,
      baseUrl: this.config.relaycastUrl,
    });
    this.ws = this.createWsClient({
      token: this.config.relaycastToken,
      baseUrl: this.config.relaycastUrl,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectBaseDelayMs: this.config.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.config.reconnectMaxDelayMs,
      debug: this.config.debug,
    });

    this.bindWebSocketHandlers();
    await this.refreshSubscriptions();
    this.healthServer = await this.createHealthServer({
      host: this.config.healthHost,
      port: this.config.healthPort,
      getSnapshot: () => this.getHealthSnapshot(),
    });
    this.ws.connect();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      await this.flushQueue();
    }

    await this.flushInFlight;
    this.ws?.disconnect();
    await this.healthServer?.close();
    this.status = 'stopped';
  }

  getHealthSnapshot(): HealthSnapshot {
    const routeMetrics = Object.fromEntries(this.routeMetrics.entries());
    return {
      status: this.status,
      bridgeId: this.config.bridgeId,
      startedAt: this.startedAt,
      queueDepth: this.queue.length,
      subscribedChannels: [...this.subscribedChannels],
      metrics: {
        ...this.metrics,
        routes: routeMetrics,
      },
    };
  }

  private bindWebSocketHandlers(): void {
    if (!this.ws) {
      return;
    }

    this.ws.on('open', () => {
      this.status = 'running';
      if (this.subscribedChannels.length > 0) {
        this.ws?.subscribe(this.subscribedChannels);
      }
    });

    this.ws.on('reconnecting', (event) => {
      const reconnect = event as WsReconnectingEvent;
      this.status = 'degraded';
      this.metrics.reconnects += 1;
      this.metrics.lastReconnectAttempt = reconnect.attempt;
    });

    this.ws.on('permanently_disconnected', (event) => {
      const disconnected = event as WsPermanentlyDisconnectedEvent;
      this.status = 'degraded';
      this.metrics.permanentlyDisconnected += 1;
      this.metrics.lastReconnectAttempt = disconnected.attempt;
    });

    this.ws.on('message.created', (event) => {
      this.enqueue(event as MessageCreatedEvent);
    });

    this.ws.on('thread.reply', (event) => {
      this.enqueue(event as ThreadReplyEvent);
    });

    this.ws.on('channel.created', (event) => {
      const channelName = (event as { channel?: { name?: string } }).channel?.name;
      if (!channelName) {
        return;
      }

      const next = new Set(this.subscribedChannels);
      if (this.matchesAnyRoute(channelName)) {
        next.add(channelName);
        this.subscribedChannels = [...next].sort();
        this.ws?.subscribe([channelName]);
      }
    });

    this.ws.on('*', (event) => {
      const wsEvent = event as WsClientEvent;
      if (wsEvent.type === 'error') {
        this.metrics.wsErrors += 1;
      }
    });
  }

  private enqueue(event: RelaycastBridgeEvent): void {
    if (!isRelaycastBridgeEvent(event)) {
      return;
    }

    this.metrics.messagesReceived += 1;
    this.queue.push({
      event,
      receivedAt: this.now().toISOString(),
    });

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushInFlight = this.flushInFlight.then(() => this.flushQueue());
      }, this.config.batchWindowMs);
    }
  }

  private async flushQueue(): Promise<void> {
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) {
      return;
    }

    this.metrics.batchesProcessed += 1;
    this.metrics.lastBatchAt = this.now().toISOString();
    await Promise.allSettled(batch.map((item) => this.processQueueItem(item)));
  }

  private async processQueueItem(item: QueueItem): Promise<void> {
    const matchingRoutes = this.config.routes.filter((route) =>
      this.routeMatches(route, item.event),
    );
    if (matchingRoutes.length === 0) {
      return;
    }

    let messageMeta: MessageWithMeta | undefined;
    try {
      messageMeta = await this.relay?.messages.get(item.event.message.id);
    } catch {
      messageMeta = undefined;
    }

    await Promise.all(
      matchingRoutes.map(async (route) => {
        const routeStats = this.routeMetrics.get(route.id);
        if (routeStats) {
          routeStats.matched += 1;
        }

        const processedAt = this.now().toISOString();
        const payload = transformRelaycastEvent({
          event: item.event,
          bridgeId: this.config.bridgeId,
          routeId: route.id,
          processedAt,
          receivedAt: item.receivedAt,
          ...(messageMeta ? { messageMeta } : {}),
        });

        try {
          await this.postWithRetry(route, payload);
          this.metrics.messagesForwarded += 1;
          this.metrics.lastForwardAt = processedAt;
          if (routeStats) {
            routeStats.forwarded += 1;
            routeStats.lastForwardedAt = processedAt;
          }
        } catch (error) {
          const reason = serializeError(error);
          this.metrics.webhookErrors += 1;
          if (routeStats) {
            routeStats.errors += 1;
            routeStats.lastError = reason;
          }
          await this.writeDeadLetter({
            failedAt: this.now().toISOString(),
            routeId: route.id,
            channel: payload.channel,
            webhookUrl: route.n8nWebhookUrl,
            reason,
            payload,
          });
          if (routeStats) {
            routeStats.deadLettered += 1;
          }
        }
      }),
    );
  }

  private async postWithRetry(
    route: BridgeRouteConfig,
    payload: RelaycastWebhookPayload,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.webhookTimeoutMs);

      try {
        const response = await this.fetchImpl(route.n8nWebhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'relaycast-n8n-bridge/0.1.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.ok) {
          clearTimeout(timer);
          return;
        }

        // Read error body with the same timeout still active
        const responseBody = await response.text();
        clearTimeout(timer);
        lastError = new Error(
          `Webhook returned ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
        );
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
      }

      if (attempt < this.config.retryAttempts) {
        const routeStats = this.routeMetrics.get(route.id);
        if (routeStats) {
          routeStats.retries += 1;
        }
        await this.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Webhook delivery failed for route ${route.id}`);
  }

  private async writeDeadLetter(entry: DeadLetterEntry): Promise<void> {
    await mkdir(dirname(this.config.deadLetterPath), { recursive: true });
    await appendFile(this.config.deadLetterPath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.metrics.deadLetters += 1;
  }

  private routeMatches(route: BridgeRouteConfig, event: RelaycastBridgeEvent): boolean {
    if (!minimatch(event.channel, route.channelPattern)) {
      return false;
    }

    const filter = route.filter;
    if (!filter) {
      return true;
    }

    if (filter.senders && !filter.senders.includes(event.message.agentName)) {
      return false;
    }

    if (filter.contentMatch) {
      const matcher = normalizeContentMatcher(filter.contentMatch);
      if (!matcher.test(event.message.text)) {
        return false;
      }
    }

    return true;
  }

  private matchesAnyRoute(channel: string): boolean {
    return this.config.routes.some((route) => minimatch(channel, route.channelPattern));
  }

  private async refreshSubscriptions(): Promise<void> {
    if (!this.relay) {
      return;
    }

    const channels = await this.relay.channels.list({ includeArchived: false });
    const existingChannels = channels.map((channel) => channel.name);
    const nextChannels = new Set<string>();

    for (const route of this.config.routes) {
      if (hasGlobPattern(route.channelPattern)) {
        for (const channel of existingChannels) {
          if (minimatch(channel, route.channelPattern)) {
            nextChannels.add(channel);
          }
        }
      } else {
        nextChannels.add(route.channelPattern);
      }
    }

    this.subscribedChannels = [...nextChannels].sort();
  }
}
