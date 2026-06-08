import type { ChannelProvider, ResolvedChannel, OpenClawReplyWebhookEvent, InboundMessage } from "./types.ts";
import type { OdooConfig } from "../../rpc.ts";

function buildReplyWebhook(cfg: OdooConfig, channelId: number, text: string, isHtml: boolean): OpenClawReplyWebhookEvent {
  const timestamp = new Date().toISOString();
  return {
    source: "openclaw",
    eventType: "message.reply",
    messageId: crypto.randomUUID(),
    timestamp,
    channel: {
      id: channelId,
      type: "group",
      isPrivate: false,
    },
    author: {
      partnerId: cfg.botPartnerId,
      name: "OpenClaw AI",
    },
    bot: {
      partnerId: cfg.botPartnerId,
      name: "OpenClaw AI",
    },
    content: {
      text: isHtml ? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : text,
      html: isHtml ? text : undefined,
      format: isHtml ? "html" : "plain",
    },
    idempotencyKey: `openclaw:${channelId}:${timestamp}`,
  };
}

/**
 * Odoo Discuss provider.
 */
export const discussProvider: ChannelProvider = {
  id: "discuss",
  label: "Odoo Discuss",

  async sendMessage(cfg: OdooConfig, channelId: number, text: string, isHtml = false): Promise<void> {
    const webhookUrl = cfg.webhookUrl?.trim();
    if (!webhookUrl) {
      throw new Error("Odoo webhookUrl is not configured");
    }

    const payload = buildReplyWebhook(cfg, channelId, text, isHtml);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Odoo-Database": cfg.db,
    };
    if (cfg.apiKey) {
      headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    }

    let resp: Response;
    try {
      resp = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      throw new Error(`Odoo webhook reply network error: ${(networkErr as Error)?.message || String(networkErr)}`);
    }

    if (!resp.ok) {
      let body = "";
      try {
        body = (await resp.text()).slice(0, 500);
      } catch {
        // ignore body read errors
      }
      throw new Error(`Odoo webhook reply failed: status=${resp.status} body=${body}`);
    }
  },

  shouldRespond(channel: ResolvedChannel, msg: InboundMessage, cfg: OdooConfig): boolean {
    if (channel.isPrivate) return true;
    return msg.partnerIds.includes(cfg.botPartnerId);
  },
};
