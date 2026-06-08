import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type { OdooConfig } from "../rpc.ts";
import type { ChannelProvider, InboundMessage, OdooWebhookEvent, ResolvedChannel, WebhookAttachment } from "./providers/types.ts";
import { getCfg } from "../config.ts";
import { getOdooRuntime } from "../runtime.ts";
import { formatOdooRichText, cleanOdooBody } from "../formatting/rich-text.ts";
import { getProvider } from "./providers/registry.ts";
import { resolveClientIp, matchesAllowedIp } from "../ip.ts";

/* ── Tracking sent message IDs for reliable bot-echo filtering ── */

const sentMessageIds = new Set<number>();
const SENT_IDS_MAX = 500;

/* ── Channel resolution cache (LRU-like) ── */

const seenWebhookKeys = new Set<string>();
const SEEN_WEBHOOK_KEYS_MAX = 500;

function rememberWebhookKey(event: OdooWebhookEvent): boolean {
  const key = String(event.idempotencyKey || `${event.source || "odoo"}:${event.messageId}`);
  if (seenWebhookKeys.has(key)) return false;
  seenWebhookKeys.add(key);
  if (seenWebhookKeys.size > SEEN_WEBHOOK_KEYS_MAX) {
    const first = seenWebhookKeys.values().next().value;
    if (first !== undefined) seenWebhookKeys.delete(first);
  }
  return true;
}

export function trackSentMessageId(id: number) {
  sentMessageIds.add(id);
  if (sentMessageIds.size > SENT_IDS_MAX) {
    const first = sentMessageIds.values().next().value;
    if (first !== undefined) sentMessageIds.delete(first);
  }
}

/* ── Filter: framework / system diagnostic messages ── */

const SYSTEM_DIAGNOSTIC_PATTERNS = [
  /Gateway restart update skipped/i,
  /openclaw\s+doctor/i,
  /Run:\s*openclaw\s/i,
];

/** Returns true when the text looks like an internal framework diagnostic that should not be forwarded to Odoo. */
function isSystemDiagnostic(text: string): boolean {
  return SYSTEM_DIAGNOSTIC_PATTERNS.some((p) => p.test(text));
}

/* ── Saved plugin API reference for outbound ── */

let savedApi: OpenClawPluginApi | null = null;

/* ── Channel plugin definition ── */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeAttachments(attachments: WebhookAttachment[] | undefined): string {
  const items = attachments?.filter((attachment) => attachment?.url) ?? [];
  if (!items.length) return "";

  const lines = ["Attachments:"];
  for (const attachment of items) {
    const name = attachment.filename || "unnamed";
    lines.push(`- ${name}`);
    lines.push(`  URL: ${attachment.url}`);
  }

  lines.push("");
  lines.push("For attachments: download to a temporary folder in the workspace, fully unpack and analyze them, then delete the temporary files immediately. Leave no cache behind.");
  lines.push("- The connection may require the X-Odoo-Database header.");

  return lines.join("\n");
}

function buildInboundBodyText(msg: InboundMessage): string {
  const bodyText = cleanOdooBody(msg.body);
  const attachmentSummary = summarizeAttachments(msg.attachments);
  if (!attachmentSummary) return bodyText;
  if (!bodyText) return attachmentSummary;
  return `${bodyText}\n\n${attachmentSummary}`;
}

function buildStructuredWebhookEvent(payload: any): OdooWebhookEvent {
  const channelId = Number(payload?.channel?.id ?? 0);
  const channelType = String(payload?.channel?.type ?? "").trim();
  const isPrivate = payload?.channel?.isPrivate;
  const mentioned = payload?.mention?.mentioned;
  const text = String(payload?.content?.text ?? "");
  const html = String(payload?.content?.html ?? "");
  const messageId = Number(payload?.messageId ?? 0);

  if (!channelId || !channelType || typeof isPrivate !== "boolean") {
    throw new Error("Malformed Odoo webhook: channel.id/type/isPrivate are required");
  }
  if (typeof mentioned !== "boolean") {
    throw new Error("Malformed Odoo webhook: mention.mentioned is required");
  }
  if (!messageId) {
    throw new Error("Malformed Odoo webhook: messageId is required");
  }
  if (!isNonEmptyString(text) && !isNonEmptyString(html) && !(Array.isArray(payload?.attachments) && payload.attachments.length > 0)) {
    throw new Error("Malformed Odoo webhook: content.text or content.html is required");
  }

  return {
    source: String(payload.source || "odoo") as any,
    eventType: String(payload.eventType || "message.posted"),
    messageId,
    timestamp: payload.timestamp ?? new Date().toISOString(),
    triggerType: String(payload.triggerType || (isPrivate ? "dm" : "group")) as any,
    channel: {
      id: channelId,
      name: String(payload.channel.name || ""),
      type: channelType as any,
      isPrivate,
    },
    author: {
      partnerId: payload?.author?.partnerId ?? null,
      name: String(payload?.author?.name || "Unknown User"),
    },
    bot: payload?.bot ? {
      partnerId: payload.bot.partnerId,
      name: payload.bot.name,
    } : undefined,
    message: {
      text,
      html,
      format: String(payload?.content?.format || (html ? "html" : "plain")) as any,
    },
    content: {
      text,
      html,
      format: String(payload?.content?.format || (html ? "html" : "plain")) as any,
    },
    attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
    mention: { mentioned },
    idempotencyKey: payload?.idempotencyKey,
  };
}

export const odooClawChannel = {
  id: "odooClaw-channel",
  meta: {
    id: "odooClaw-channel",
    label: "OdooClaw Channel",
    selectionLabel: "OdooClaw Channel (local deploy)",
    docsPath: "/channels/odooClaw-channel",
    blurb: "OdooClaw channel plugin supporting DMs and group channels via configurable providers (Discuss, Helpdesk, etc.).",
    aliases: ["odooClaw-channel", "odooClaw", "odoo-discuss"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  config: {
    listAccountIds: (cfg: any) => {
      const channelCfg = cfg?.channels?.["odooClaw-channel"];
      return channelCfg ? ["default"] : [];
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const channelCfg = cfg?.channels?.["odooClaw-channel"];
      return channelCfg ? { accountId, ...(channelCfg.odoo || channelCfg) } : null;
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, to }: { text: string; to: string }) => {
      if (!savedApi) return { ok: false, error: "OdooClaw plugin API not initialized" };
      const cfg = getCfg(savedApi);
      if (!cfg) return { ok: false, error: "Odoo not configured" };

      if (isSystemDiagnostic(text)) return { ok: true };

      const match = to.match(/^(?:channel|chat|group):(\d+)$/) ?? to.match(/^(\d+)$/);
      if (!match) return { ok: false, error: `Invalid 'to' format: ${to}` };

      const channelId = parseInt(match[1], 10);
      const provider = getProvider(cfg.provider);
      await provider.sendMessage(cfg, channelId, text);
      return { ok: true };
    },
  },
};

export async function handleOdooWebhookRequest(api: OpenClawPluginApi, req: IncomingMessage, res: ServerResponse) {
  if ((req.method || "").toUpperCase() !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const cfg = getCfg(api);
  if (!cfg) {
    res.statusCode = 503;
    res.end("Odoo not configured");
    return true;
  }

  const clientIp = resolveClientIp(req);
  if (cfg.allowedSourceIps.length > 0 && (!clientIp || !matchesAllowedIp(clientIp, cfg.allowedSourceIps))) {
    res.statusCode = 403;
    res.end("Forbidden");
    api.logger?.warn(`[odooClaw] webhook rejected from IP: ${clientIp || "unknown"}`);
    return true;
  }

  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = typeof apiKeyHeader === "string" ? apiKeyHeader : Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : "";
  const expectedApiKey = cfg.apiKey?.trim() || "";
  if (!expectedApiKey || apiKey.trim() !== expectedApiKey) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  const rawBody = await new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

  let payload: any;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.statusCode = 400;
    res.end("Invalid Odoo webhook JSON");
    return true;
  }

  let event: OdooWebhookEvent;
  try {
    event = buildStructuredWebhookEvent(payload);
  } catch (error) {
    res.statusCode = 400;
    res.end(error instanceof Error ? error.message : "Invalid Odoo webhook payload");
    return true;
  }

  try {
    await handleWebhookEvent(api, event);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    api.logger?.error(`[odooClaw] webhook handling failed: ${String(error)}`);
    res.statusCode = 500;
    res.end("Webhook handling failed");
  }
  return true;
}

/* ── Inbound: route to agent session ── */

async function handleInboundMessage(
  api: OpenClawPluginApi,
  cfg: OdooConfig,
  msg: InboundMessage,
  channel: ResolvedChannel,
  provider: ChannelProvider,
) {
  const core = getOdooRuntime();
  const channelId = msg.channelId;

  const isPrivateChat = channel.isPrivate;
  const authorId = String(msg.authorId?.[0] ?? "unknown");
  const authorName = msg.authorId?.[1] ?? "Unknown User";
  const peerId = String(channelId);
  const resolvedRoute = core.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: "odooClaw-channel",
    accountId: "default",
    peer: {
      kind: isPrivateChat ? "direct" : "group",
      id: peerId,
    },
  });
  const agentId = resolvedRoute?.agentId || "main";
  const accountId = resolvedRoute?.accountId || "default";
  const sessionKey = `agent:${agentId}:odooClaw:${isPrivateChat ? "dm" : "group"}:${peerId}`;
  const chatType = isPrivateChat ? "direct" : "group";
  const to = isPrivateChat ? `chat:${channelId}` : `channel:${channelId}`;
  const fromLabel = isPrivateChat ? authorName : `${channel.name || `channel-${channelId}`} / ${authorName}`;
  const bodyText = buildInboundBodyText(msg);

  core.system.enqueueSystemEvent(
    isPrivateChat
      ? `Odoo DM from ${authorName}: ${bodyText.slice(0, 160)}`
      : `Odoo message in ${channel.name || channelId} from ${authorName}: ${bodyText.slice(0, 160)}`,
    {
      sessionKey,
      contextKey: `odooClaw:message:${channelId}:${msg.id}`,
    },
  );

  const body = core.channel.reply.formatInboundEnvelope({
    channel: provider.label,
    from: fromLabel,
    timestamp: msg.date ? Date.parse(msg.date) : undefined,
    body: bodyText,
    chatType,
    sender: { name: authorName, id: authorId },
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: isPrivateChat ? `odooClaw:${authorId}` : `odooClaw:channel:${channelId}`,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: !isPrivateChat ? (channel.name || `channel-${channelId}`) : undefined,
    SenderName: authorName,
    SenderId: authorId,
    Provider: "odooClaw",
    Surface: "odooClaw",
    MessageSid: String(msg.id),
    Timestamp: msg.date ? Date.parse(msg.date) : undefined,
    WasMentioned: !isPrivateChat ? msg.partnerIds.includes(cfg.botPartnerId) : undefined,
    Attachments: (msg.attachments ?? []).filter((attachment) => Boolean(attachment?.url)).map((attachment) => ({
      filename: attachment.filename,
      url: attachment.url,
    })),
    HasAttachments: Boolean(msg.attachments?.some((attachment) => attachment?.url)),
    OriginatingChannel: "odooClaw-channel",
    OriginatingTo: to,
  });

  if (isPrivateChat) {
    const storePath = core.channel.session.resolveStorePath(api.config?.session?.store, {
      agentId: agentId,
    });
    await core.channel.session.updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "odooClaw-channel",
        to,
        accountId: accountId,
      },
    });
  }

  const textLimit = core.channel.text.resolveTextChunkLimit(api.config, "odooClaw-channel", "default", {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(api.config, "odooClaw-channel", "default");
  const formatFn = provider.formatOutbound ?? formatOdooRichText;
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    humanDelay: core.channel.reply.resolveHumanDelayConfig(api.config, agentId),
    deliver: async (payload: { text?: string }, info: { kind: "tool" | "block" | "final" }) => {
      if (info.kind !== "final") return;
      const text = payload.text ?? "";
      if (isSystemDiagnostic(text)) return;
      if (!text.trim()) return;
      const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
      for (const chunk of chunks.length > 0 ? chunks : [text]) {
        if (!chunk) continue;
        try {
          await provider.sendMessage(cfg, channelId, formatFn(chunk), true);
          api.logger?.info(`odooClaw-channel reply sent ch=${channelId} kind=${chatType} len=${chunk.length}`);
        } catch (err) {
          api.logger?.error(`odooClaw-channel reply send failed ch=${channelId} kind=${chatType} err=${String(err)}`);
          throw err;
        }
      }
    },
    onError: (err: unknown, info: { kind: string }) => {
      api.logger?.error(`odooClaw ${info.kind} reply failed: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: api.config,
    dispatcher,
    replyOptions,
  });
  markDispatchIdle();
}

function normalizeWebhookEvent(event: OdooWebhookEvent, botPartnerId: number): InboundMessage {
  const body = event.content?.html?.trim() || event.content?.text?.trim() || event.message.html?.trim() || event.message.text?.trim() || "";
  return {
    id: event.messageId,
    body,
    authorId: event.author.partnerId != null ? [event.author.partnerId, event.author.name ?? "Unknown User"] : null,
    partnerIds: event.mention?.mentioned ? [botPartnerId] : [],
    channelId: event.channel.id,
    date: typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : event.timestamp,
    content: event.content ?? event.message,
    attachments: event.attachments,
  };
}

function resolveWebhookChannel(event: OdooWebhookEvent): ResolvedChannel {
  return {
    id: event.channel.id,
    name: event.channel.name,
    type: event.channel.type === "chat" ? "dm" : event.channel.type,
    isPrivate: event.channel.isPrivate,
  };
}

export async function handleWebhookEvent(api: OpenClawPluginApi, event: OdooWebhookEvent) {
  const cfg = getCfg(api);
  if (!cfg) {
    throw new Error("Odoo not configured");
  }

  if (!rememberWebhookKey(event)) return;

  const bodyText = cleanOdooBody(event.content?.html?.trim() || event.content?.text?.trim() || event.message.html?.trim() || event.message.text?.trim() || "");
  if (!bodyText && !(event.attachments && event.attachments.length)) return;

  if (event.author.partnerId && event.bot?.partnerId && event.author.partnerId === event.bot.partnerId) {
    return;
  }

  const provider = getProvider(cfg.provider);
  const msg = normalizeWebhookEvent(event, cfg.botPartnerId);
  const channel = resolveWebhookChannel(event);

  if (!provider.shouldRespond(channel, msg, cfg)) {
    return;
  }

  api.logger?.info(
    `odooClaw-channel webhook: new message ch=${channel.id} provider=${provider.id} from=${event.author.name ?? "unknown"}: ${bodyText.slice(0, 80)}`,
  );

  const botInMentioned = msg.partnerIds.includes(cfg.botPartnerId);
  api.logger?.info(
    `odooClaw-channel webhook context: ch=${channel.id} channelType=${channel.type} isPrivate=${channel.isPrivate} botPartnerId=${cfg.botPartnerId} botInMentioned=${botInMentioned} mentionedPartnerCount=${msg.partnerIds.length}`,
  );

  await handleInboundMessage(api, cfg, msg, channel, provider);
}

export function registerWebhookService(api: OpenClawPluginApi) {
  savedApi = api;

  api.registerService({
    id: "odooClaw-webhook",
    start: async () => {
      api.logger?.info("odooClaw-channel: webhook service registered");
    },
    stop: async () => {
      api.logger?.info("odooClaw-channel: webhook service stopped");
    },
  });
}
