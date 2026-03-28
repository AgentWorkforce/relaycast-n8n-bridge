import type {
  MessageCreatedEvent,
  MessageWithMeta,
  ThreadReplyEvent,
} from '@relaycast/sdk';

export type RelaycastBridgeEvent = MessageCreatedEvent | ThreadReplyEvent;
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RelaycastBridgeMetadata {
  prNumber?: number;
  filePaths?: string[];
  severity?: Severity;
  agentRole?: string;
  agentId: string;
  messageId: string;
  parentId?: string;
  attachments?: Array<{
    fileId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }>;
}

export interface RelaycastWebhookPayload {
  source: 'relaycast';
  channel: string;
  message: {
    id: string;
    sender: string;
    content: string;
    timestamp: string;
    type: RelaycastBridgeEvent['type'];
    parentId?: string;
  };
  metadata: RelaycastBridgeMetadata;
  bridge: {
    id: string;
    route: string;
    processedAt: string;
  };
}

export interface TransformRelaycastEventOptions {
  event: RelaycastBridgeEvent;
  bridgeId: string;
  routeId: string;
  processedAt: string;
  receivedAt: string;
  messageMeta?: MessageWithMeta;
}

const severityPattern = /\b(critical|high|medium|low|info)\b/i;
const prPattern = /\b(?:pr|pull request)\s*#?(\d+)\b|#(\d+)\b/i;
const filePathPattern =
  /\b(?:[A-Za-z]:)?(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10}\b/g;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function inferAgentRole(sender: string, text: string, messageMeta?: MessageWithMeta): string | undefined {
  const fromMetadata = messageMeta?.metadata?.agentRole;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) {
    return fromMetadata.trim();
  }

  const roleMatch = text.match(/\brole:\s*([a-z0-9_-]+)/i);
  if (roleMatch?.[1]) {
    return roleMatch[1].toLowerCase();
  }

  const normalized = sender.toLowerCase();
  if (normalized.includes('security')) {
    return 'security';
  }
  if (normalized.includes('review')) {
    return 'reviewer';
  }
  if (normalized.includes('build')) {
    return 'builder';
  }
  if (normalized.includes('synth')) {
    return 'synthesizer';
  }
  if (normalized.includes('arch')) {
    return 'architect';
  }

  return undefined;
}

function extractPrNumber(text: string): number | undefined {
  const match = text.match(prPattern);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

function extractSeverity(text: string): Severity | undefined {
  const match = text.match(severityPattern);
  if (!match?.[1]) {
    return undefined;
  }

  return match[1].toLowerCase() as Severity;
}

function extractFilePaths(
  text: string,
  messageMeta?: MessageWithMeta,
): string[] | undefined {
  const fromText = Array.from(text.matchAll(filePathPattern), (match) => match[0])
    .filter((candidate) => !candidate.startsWith('http'))
    .map((candidate) => candidate.replace(/[),.:;]+$/, ''));
  const fromAttachments = (messageMeta?.attachments ?? []).map((attachment) => attachment.filename);
  const filePaths = unique([...fromText, ...fromAttachments]);
  return filePaths.length > 0 ? filePaths : undefined;
}

export function isRelaycastBridgeEvent(event: { type: string }): event is RelaycastBridgeEvent {
  return event.type === 'message.created' || event.type === 'thread.reply';
}

export function transformRelaycastEvent(
  options: TransformRelaycastEventOptions,
): RelaycastWebhookPayload {
  const { event, bridgeId, routeId, processedAt, receivedAt, messageMeta } = options;
  const text = messageMeta?.text ?? event.message.text;
  const timestamp = messageMeta?.createdAt ?? receivedAt;
  const parentId = event.type === 'thread.reply' ? event.parentId : undefined;
  const attachments =
    (messageMeta?.attachments ?? event.message.attachments ?? []).map((attachment) => ({
      fileId: attachment.fileId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    }));
  const prNumber = extractPrNumber(text);
  const filePaths = extractFilePaths(text, messageMeta);
  const severity = extractSeverity(text);
  const agentRole = inferAgentRole(event.message.agentName, text, messageMeta);

  const metadata: RelaycastBridgeMetadata = {
    agentId: event.message.agentId,
    messageId: event.message.id,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(filePaths ? { filePaths } : {}),
    ...(severity ? { severity } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(parentId ? { parentId } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  return {
    source: 'relaycast',
    channel: event.channel,
    message: {
      id: event.message.id,
      sender: event.message.agentName,
      content: text,
      timestamp,
      type: event.type,
      ...(parentId ? { parentId } : {}),
    },
    metadata,
    bridge: {
      id: bridgeId,
      route: routeId,
      processedAt,
    },
  };
}
