/**
 * Standard Intercom webhook handler (Developer Hub app webhooks).
 * - conversation.admin.replied  -> forward the human agent's reply to Telegram
 * - conversation.admin.closed   -> end the handoff, return the player to Fin
 * Verifies the X-Hub-Signature (HMAC-SHA1 of the raw body with the app client secret).
 */
import type { Env } from "./env";
import { workflowBridge } from "./env";
import { getUserByIntercomConversation, alreadyRelayedPart } from "./kv";
import { htmlToPlainText } from "./html";
import { sendToChannel } from "./channels";
import { endHandoff } from "./intercom";

interface ConversationPart {
  id?: string;
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

    if (workflowBridge(env, ref.channel)) {
      // Workflow Bridge: relay every NEW Fin (bot) + agent (admin) comment, in order,
      // deduped by part id. Skip the customer's own (author "user") and notes — no echo.
      for (const p of parts) {
        if (p.part_type !== "comment") continue;
        const at = p.author?.type ?? "";
        if (at !== "bot" && at !== "admin") continue;
        if (!p.body) continue;
        if (p.id && (await alreadyRelayedPart(env, p.id))) continue;
        const prefix = at === "admin" ? "👤 " : ""; // Fin answers plain; human prefixed
        await sendToChannel(env, ref.channel, ref.cuid, `${prefix}${htmlToPlainText(String(p.body))}`);
      }
      return ok();
    }

    // --- mirror/handoff mode (flag off): newest human-agent comment only ---
    // Fin answers + handoff notes are part_type "note"; customer mirrors are author "user";
    // the Fin bot is author "bot"; assignments aren't comments. So this is a real agent reply.
    const last = [...parts].reverse().find((p) => p.part_type === "comment" && p.author?.type === "admin");
    if (last?.body) {
      if (last.id && (await alreadyRelayedPart(env, last.id))) return ok(); // dedupe Intercom webhook retries
      await sendToChannel(env, ref.channel, ref.cuid, `👤 ${htmlToPlainText(String(last.body))}`);
    }
    return ok();
  }

  if (topic === "conversation.admin.closed" || topic === "conversation.closed") {
    if (workflowBridge(env, ref.channel)) {
      // Do NOT clear the mapping here. The next inbound message checks whether the conversation
      // is still open: if open it's reused (one conversation per customer); if closed, a fresh
      // one is started. This keeps a customer's follow-ups in ONE conversation.
      return ok();
    }
    // Mirror/handoff mode: end human mode and let the customer know.
    await endHandoff(env, ref.channel, ref.cuid);
    await sendToChannel(env, ref.channel, ref.cuid, "✅ This chat is closed. Send a new message and we'll be glad to help again.");
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
