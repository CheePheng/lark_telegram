/**
 * Standard Intercom webhook handler (Developer Hub app webhooks).
 * - conversation.admin.replied  -> forward the human agent's reply to Telegram
 * - conversation.admin.closed   -> end the handoff, return the player to Fin
 * Verifies the X-Hub-Signature (HMAC-SHA1 of the raw body with the app client secret).
 */
import type { Env } from "./env";
import { getUserByIntercomConversation, clearHandoff } from "./kv";
import { htmlToPlainText } from "./html";
import { sendToChannel } from "./channels";

interface ConversationPart {
  part_type?: string;
  body?: string;
  author?: { type?: string };
}

export async function handleIntercomWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyHubSignature(env, raw, request.headers.get("X-Hub-Signature")))) {
    console.warn("INTERCOM_WEBHOOK_SIG_FAIL");
    return new Response("invalid signature", { status: 401 });
  }

  let evt: { topic?: string; data?: { item?: any } };
  try {
    evt = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const topic = evt.topic ?? "";
  const convo = evt.data?.item;
  const intercomId = String(convo?.id ?? "");
  if (!intercomId) return ok();

  const ref = await getUserByIntercomConversation(env, intercomId);
  if (!ref) return ok(); // not one of our bridged conversations

  if (topic === "conversation.admin.replied") {
    const parts: ConversationPart[] = convo?.conversation_parts?.conversation_parts ?? [];
    // Newest human-agent comment (skip the Fin bot, which is author.type "bot").
    const last = [...parts].reverse().find((p) => p.part_type === "comment" && p.author?.type === "admin");
    if (last?.body) await sendToChannel(env, ref.channel, ref.cuid, `👤 ${htmlToPlainText(String(last.body))}`);
    return ok();
  }

  if (topic === "conversation.admin.closed" || topic === "conversation.closed") {
    await clearHandoff(env, ref.channel, ref.cuid, intercomId);
    await sendToChannel(env, ref.channel, ref.cuid, "✅ This support chat is closed. Ask me anything and Fin will help again.");
    return ok();
  }

  return ok();
}

async function verifyHubSignature(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const provided = header.replace(/^sha1=/i, "").trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.INTERCOM_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === provided;
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}
