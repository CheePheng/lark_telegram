/**
 * Lark custom-app channel (the "real account" the bot speaks as).
 *
 * - Outbound: get a tenant_access_token, POST im/v1/messages (text).
 * - Inbound:  /lark/webhook receives the URL-verification challenge and
 *             im.message.receive_v1 events; we forward text DMs to Fin.
 *
 * Lark international (open.larksuite.com). Event schema v2, no Encrypt Key.
 */
import type { Env } from "./env";
import { getCachedLarkToken, setCachedLarkToken } from "./kv";
import { routeInbound } from "./inbound";

const LARK_BASE = "https://open.larksuite.com/open-apis";

async function tenantToken(env: Env): Promise<string> {
  const cached = await getCachedLarkToken(env);
  if (cached) return cached;
  const res = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const d = (await res.json()) as { tenant_access_token?: string; expire?: number };
  if (!d.tenant_access_token) throw new Error(`Lark token failed: ${JSON.stringify(d)}`);
  await setCachedLarkToken(env, d.tenant_access_token, d.expire ?? 7200);
  return d.tenant_access_token;
}

/** Send a plain-text message to a Lark user by their open_id. */
export async function sendLarkMessage(env: Env, openId: string, text: string): Promise<void> {
  const token = await tenantToken(env);
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const d = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (d.code !== 0) console.error(`Lark send failed: ${JSON.stringify(d)}`);
}

interface LarkEvent {
  type?: string; // legacy "url_verification"
  challenge?: string;
  token?: string; // legacy token location
  header?: { event_type?: string; token?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: { message_type?: string; content?: string; chat_type?: string };
  };
}

export async function handleLarkWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as LarkEvent | null;
  if (!body) return new Response("bad json", { status: 400 });

  // 1) URL verification handshake (sent once when you set the Request URL).
  if (body.type === "url_verification") return json({ challenge: body.challenge });

  // 2) Verify the verification token (present in header for v2, top-level for v1).
  const token = body.header?.token ?? body.token;
  if (token !== env.LARK_VERIFICATION_TOKEN) {
    console.warn("LARK_WEBHOOK_TOKEN_FAIL");
    return new Response("invalid token", { status: 401 });
  }

  // 3) Inbound message.
  if (body.header?.event_type === "im.message.receive_v1") {
    const sender = body.event?.sender;
    const openId = sender?.sender_id?.open_id;
    const msg = body.event?.message;
    // Ignore non-user senders (e.g. our own bot) to avoid loops.
    if (openId && sender?.sender_type !== "app" && msg?.message_type === "text") {
      const text = (safeParse(msg.content) as { text?: string }).text?.trim() ?? "";
      const clean = stripMentions(text);
      if (clean) await routeInbound(env, "lark", openId, clean);
    }
  }

  return json({ code: 0 });
}

/** Lark prefixes @-mentions in group text as "@_user_1"; strip them for clean intent. */
function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").trim();
}

function safeParse(s: string | undefined): unknown {
  try {
    return JSON.parse(s ?? "{}");
  } catch {
    return {};
  }
}

function json(b: unknown): Response {
  return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
}
