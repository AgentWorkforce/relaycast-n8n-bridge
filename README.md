# relaycast-n8n-bridge

Bridge relaycast channel traffic into n8n webhooks so agent findings can trigger Slack, Jira, PagerDuty, or any other n8n workflow target.

## Quick Start

1. Create a config file:

```json
{
  "bridgeId": "local-bridge",
  "relaycastUrl": "https://api.relaycast.dev",
  "relaycastToken": "rcast_...",
  "routes": [
    {
      "channelPattern": "review-*",
      "n8nWebhookUrl": "https://n8n.example/webhook/review-findings"
    }
  ]
}
```

2. Install and build:

```bash
npm install
npm run build
```

3. Start the bridge:

```bash
npx relaycast-n8n-bridge start --config bridge.json
```

4. Check health:

```bash
npx relaycast-n8n-bridge health --config bridge.json
```

The bridge accepts `relayfileUrl` and `relayfileToken` as legacy aliases, but the runtime uses `@relaycast/sdk` because that package exposes the relaycast WebSocket client.

## Behavior

- Subscribes to relaycast channels matched from configured glob routes.
- Queues incoming relaycast messages for 100ms before flushing them.
- Forwards each message to matching n8n webhooks with 3-attempt exponential backoff.
- Writes permanently failed webhook deliveries to a local JSONL dead-letter file.
- Exposes `GET /health` with counters for messages, retries, errors, reconnections, and per-route stats.

## n8n Payload

Each forwarded item is posted as JSON:

```json
{
  "source": "relaycast",
  "channel": "review-123",
  "message": {
    "id": "msg_123",
    "sender": "reviewer-bot",
    "content": "High severity issue in src/api.ts for PR #42",
    "timestamp": "2026-03-28T15:13:00.000Z",
    "type": "message.created"
  },
  "metadata": {
    "prNumber": 42,
    "filePaths": ["src/api.ts"],
    "severity": "high",
    "agentRole": "reviewer",
    "agentId": "agt_123"
  },
  "bridge": {
    "id": "local-bridge",
    "route": "route-1",
    "processedAt": "2026-03-28T15:13:00.118Z"
  }
}
```

## Example n8n Workflow

1. Add a `Webhook` trigger node with method `POST`.
2. Point `n8nWebhookUrl` in the bridge config to that trigger URL.
3. Add a `Switch` or `IF` node using:
   - `{{$json.metadata.severity}}`
   - `{{$json.metadata.prNumber}}`
   - `{{$json.channel}}`
4. Route to Slack, Jira, PagerDuty, or other downstream nodes.

Typical examples:

- `review-*` -> Slack notification for code review findings
- `security-*` -> PagerDuty for `critical` or `high`
- `synthesis-*` -> Jira ticket creation using `prNumber` and extracted `filePaths`

## CLI

```bash
npx relaycast-n8n-bridge start --config bridge.json
npx relaycast-n8n-bridge test --config bridge.json --route "review-*"
npx relaycast-n8n-bridge health --config bridge.json
```

## Docker

Build the container:

```bash
docker build -t relaycast-n8n-bridge .
```

Run it with a mounted config:

```bash
docker run --rm -p 8787:8787 \
  -v "$PWD/bridge.json:/app/bridge.json:ro" \
  relaycast-n8n-bridge
```

The image starts with `node dist/cli.js start --config /app/bridge.json`. Override the command if you want to run `health` or `test`.
