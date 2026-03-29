/**
 * 056-relaycast-n8n-bridge.ts
 *
 * Build the relaycast-n8n-bridge — connect relaycast channels to n8n workflows.
 * When agents post findings to a relaycast channel, n8n picks them up and
 * routes them to Slack, email, Jira, Linear, or any of n8n's 400+ integrations.
 *
 * Architecture:
 * - WebSocket client subscribes to relaycast channels
 * - On new message: POST to n8n webhook trigger URL
 * - n8n workflow processes and distributes (Slack, email, Jira, etc.)
 * - Optional: n8n can POST back to relaycast via the action node
 *
 * Run: agent-relay run workflows/056-relaycast-n8n-bridge.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast-n8n-bridge';
const SDK_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce-relayfile';
const CLOUD_ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
  const result = await workflow('relaycast-n8n-bridge')
    .description('Build relaycast↔n8n bridge — route agent findings to n8n workflows')
    .pattern('linear')
    .channel('wf-relaycast-n8n')
    .maxConcurrency(2)
    .timeout(2_400_000)

    .agent('architect', { cli: 'claude', role: 'Designs the bridge architecture' })
    .agent('builder', { cli: 'codex', preset: 'worker', role: 'Implements the bridge' })
    .agent('reviewer', { cli: 'claude', role: 'Reviews the implementation' })

    .step('design', {
      agent: 'architect',
      task: `Design the relaycast↔n8n bridge.

Read for context:
- ${SDK_ROOT}/packages/sdk/typescript/src/client.ts — RelayFileClient, connectWebSocket
- ${CLOUD_ROOT}/packages/relayfile/src/ — look for relaycast/channel types if present
- ${SDK_ROOT}/packages/sdk/typescript/src/types.ts — WebSocketConnection, event types

The bridge connects relaycast (real-time agent communication channels)
to n8n (workflow automation). This enables:

1. Agent posts code review finding → n8n workflow → Slack notification
2. PR review synthesized → n8n workflow → Jira ticket created
3. Security finding detected → n8n workflow → PagerDuty alert

Design:

1. **Bridge Server** (src/bridge.ts):
   - Subscribes to one or more relaycast channels via WebSocket
   - On message: forward to configured n8n webhook URL(s)
   - Message format: { channel, sender, content, timestamp, metadata }
   - Configurable routing: channel patterns → n8n webhook URLs
   - Reconnection with exponential backoff

2. **Configuration** (src/config.ts):
   - BridgeConfig: {
       relayfileUrl: string,
       relayfileToken: string,
       routes: Array<{
         channelPattern: string,  // e.g., "review-*" or "alerts"
         n8nWebhookUrl: string,
         filter?: { senders?: string[], contentMatch?: string }
       }>
     }
   - Load from env, JSON file, or programmatic

3. **Message Transformer** (src/transform.ts):
   - Transform relaycast messages to n8n-friendly format
   - Extract structured data: PR number, file paths, severity
   - Add bridge metadata: bridgeId, routeId, processedAt

4. **CLI** (src/cli.ts):
   - npx relaycast-n8n-bridge start --config bridge.json
   - npx relaycast-n8n-bridge test --route "review-*" (dry run)
   - npx relaycast-n8n-bridge health

5. **n8n Webhook Payload Schema**:
   {
     source: "relaycast",
     channel: string,
     message: { sender, content, timestamp },
     metadata: { prNumber?, filePaths?, severity?, agentRole? },
     bridge: { id, route, processedAt }
   }

6. **Health & Observability**:
   - /health endpoint
   - Metrics: messages forwarded, errors, reconnections
   - Dead letter queue for failed forwards

Output: architecture, config schema, message flow. Keep under 70 lines.
End with DESIGN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'DESIGN_COMPLETE' },
      timeout: 300_000,
    })

    .step('implement', {
      agent: 'builder',
      dependsOn: ['design'],
      task: `Implement the relaycast↔n8n bridge.

Design: {{steps.design.output}}

Working in ${ROOT}.

1. Package setup:
   - package.json: name "relaycast-n8n-bridge", bin for CLI
   - Dependencies: @relayfile/sdk (for WebSocket client), ws (WebSocket)
   - tsconfig.json

2. Implement:
   - src/bridge.ts — WebSocket subscription + message forwarding
   - src/config.ts — configuration loading + validation
   - src/transform.ts — message transformation
   - src/cli.ts — CLI entry point (start, test, health)
   - src/health.ts — HTTP health endpoint
   - src/index.ts — programmatic API

3. Key behaviors:
   - Auto-reconnect on WebSocket disconnect
   - Route matching: glob patterns for channel names
   - Message batching: collect messages for 100ms before forwarding
   - Retry failed n8n webhook calls (3 attempts, exponential backoff)
   - Dead letter: write failed messages to local file

4. README with:
   - Quick start (bridge.json config + run)
   - Example n8n workflow that receives relaycast messages
   - Docker support

5. Tests + build check
6. Commit on feat/scaffold + push

End with IMPLEMENT_COMPLETE.`,
      verification: { type: 'output_contains', value: 'IMPLEMENT_COMPLETE' },
      timeout: 900_000,
    })

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['implement'],
      task: `Review relaycast-n8n-bridge in ${ROOT}.

Verify:
1. WebSocket reconnection with backoff
2. Route matching works for glob patterns
3. Message transform extracts structured data
4. Failed forwards go to dead letter
5. CLI has start/test/health commands
6. No hardcoded URLs or tokens
7. README has working quick start

Fix issues. Keep under 40 lines. End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
      timeout: 300_000,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: ROOT });

  console.log('Relaycast n8n bridge complete:', result.status);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
