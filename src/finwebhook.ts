/**
 * Inbound Fin webhook handler: verifies the signature, routes Fin's answer back
 * to the right Telegram chat (fin_replied), and tidies up finished conversations
 * (fin_status_updated: escalated / resolved / complete).
 */
import type { Env } from "./env";
import { parseFinWebhook, verifyFinWebhookSignature } from "./fin";
import { getTelegramByConversation, clearConversation, appendTranscript, getTranscript } from "./kv";
import { htmlToPlainText } from "./html";
import { sendTelegramMessage } from "./telegram";
import { startHandoff } from "./intercom";

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
    await appendTranscript(env, tgUserId, "fin", text);
    await sendTelegramMessage(env, tgUserId, text);
    return ok();
  }

  if (event.type === "fin_status_updated") {
    const tgUserId = await getTelegramByConversation(env, event.conversationId);
    if (!tgUserId) return ok();

    if (event.status === "escalated") {
      // Fin escalates on its own (e.g. low confidence). Only hand off to a human
      // when the customer actually asked for one — otherwise keep them with Fin.
      const transcript = await getTranscript(env, tgUserId);
      const lastCustomer = [...transcript].reverse().find((t) => t.role === "customer")?.text ?? "";
      if (wantsHuman(lastCustomer)) {
        await startHandoff(env, tgUserId, lastCustomer);
        await clearConversation(env, tgUserId, event.conversationId);
      } else {
        console.log("FIN_ESCALATION_IGNORED " + JSON.stringify({ lastCustomer }));
      }
    } else if (event.status === "resolved" || event.status === "complete") {
      await clearConversation(env, tgUserId, event.conversationId);
    }
    return ok();
  }

  return ok();
}

/** True if the customer's message is clearly asking to reach a human/agent. */
function wantsHuman(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(human|live agent|real person|representative)\b/.test(t) ||
    /\bagent\b/.test(t) ||
    /(speak|talk|chat|connect|pass|transfer).{0,15}(human|agent|someone|person|representative|team|staff)/.test(t)
  );
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}
