/**
 * Inbound Fin webhook handler: verifies the signature, routes Fin's answer back
 * to the right Telegram chat (fin_replied), and tidies up finished conversations
 * (fin_status_updated: escalated / resolved / complete).
 */
import type { Env } from "./env";
import { parseFinWebhook, verifyFinWebhookSignature } from "./fin";
import { getTelegramByConversation, clearConversation } from "./kv";
import { htmlToPlainText } from "./html";
import { sendTelegramMessage } from "./telegram";

export async function handleFinWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("X-Fin-Agent-API-Webhook-Signature");

  if (!(await verifyFinWebhookSignature(env, raw, signature))) {
    console.warn("FIN_WEBHOOK_SIG_FAIL " + JSON.stringify({ signature, bodyLen: raw.length }));
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const event = parseFinWebhook(payload);

  if (event.type === "fin_replied") {
    const tgUserId = await getTelegramByConversation(env, event.conversationId);
    if (!tgUserId) {
      console.warn(`No Telegram chat for Fin conversation ${event.conversationId}`);
      return ok();
    }
    const text = htmlToPlainText(event.replyHtml) || "(Fin sent an empty reply)";
    await sendTelegramMessage(env, tgUserId, text);
    return ok();
  }

  if (event.type === "fin_status_updated") {
    const tgUserId = await getTelegramByConversation(env, event.conversationId);
    if (tgUserId && event.status === "escalated") {
      await sendTelegramMessage(env, tgUserId, "🔔 This has been escalated to our team — someone will follow up here.");
    }
    if (tgUserId && (event.status === "escalated" || event.status === "resolved" || event.status === "complete")) {
      await clearConversation(env, tgUserId, event.conversationId);
    }
    return ok();
  }

  return ok();
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}
