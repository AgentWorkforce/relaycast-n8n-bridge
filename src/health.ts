import { createServer, type Server } from 'node:http';

export interface HealthSnapshot {
  status: 'starting' | 'running' | 'degraded' | 'stopped';
  bridgeId: string;
  startedAt: string;
  queueDepth: number;
  subscribedChannels: string[];
  metrics: Record<string, unknown>;
}

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

export interface StartHealthServerOptions {
  host: string;
  port: number;
  getSnapshot(): HealthSnapshot;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startHealthServer(
  options: StartHealthServerOptions,
): Promise<HealthServer> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(options.getSnapshot(), null, 2));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : options.port;
  const host = options.host === '0.0.0.0' ? '127.0.0.1' : options.host;

  return {
    url: `http://${host}:${port}/health`,
    close: () => closeServer(server),
  };
}
