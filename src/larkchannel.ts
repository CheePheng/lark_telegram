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
import { getCachedLarkToken, setCachedLarkToken, alreadyProcessedEvent, setBrand } from "./kv";
import { routeInbound, resetChannel } from "./inbound";
import { BRAND_OPTIONS, BRAND_PROMPT, brandByKey } from "./brands";
import type { FinAnswer } from "./html";

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

/** Download an image URL and upload it to Lark, returning its image_key. Throws on failure
 *  (logs the Lark error code) so callers can fall back to text. Needs the im:resource scope. */
async function uploadLarkImage(token: string, url: string): Promise<string> {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`download failed: ${img.status}`);
  const blob = await img.blob();
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", blob, "image.png");
  const up = await fetch(`${LARK_BASE}/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }, // let FormData set the multipart Content-Type
    body: form,
  });
  const upd = (await up.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { image_key?: string } };
  if (!upd.data?.image_key) throw new Error(`upload failed: code=${upd.code} msg=${upd.msg}`);
  return upd.data.image_key;
}

/** Relay a single image to a Lark user as a standalone image message (used for non-Fin cases). */
export async function sendLarkImage(env: Env, openId: string, url: string): Promise<void> {
  const token = await tenantToken(env);
  let imageKey: string;
  try {
    imageKey = await uploadLarkImage(token, url);
  } catch (e) {
    console.error(`Lark image relay failed: ${e}`);
    return;
  }
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "image", content: JSON.stringify({ image_key: imageKey }) }),
  });
  const d = (await res.json().catch(() => ({}))) as { code?: number };
  if (d.code !== 0) console.error(`Lark image send failed: ${JSON.stringify(d)}`);
}

/** Render a Fin answer as ONE Lark interactive card: title "Answer", the body as lark_md
 *  (so links render as clickable hyperlinks), image(s) inline, and a "Sources:" list of
 *  Markdown links. Images are uploaded for an image_key; a failed upload just omits that image.
 *  Only if the whole card send fails do we fall back to a plain-text message. */
export async function sendLarkAnswerCard(env: Env, openId: string, answer: FinAnswer): Promise<void> {
  const token = await tenantToken(env);

  const imageKeys: string[] = [];
  for (const url of answer.imageUrls) {
    try {
      imageKeys.push(await uploadLarkImage(token, url));
    } catch (e) {
      console.error(`Lark card image upload failed: ${e}`); // omit this image; card still sent
    }
  }

  const elements: Array<Record<string, unknown>> = [];
  if (answer.textMd.trim()) elements.push({ tag: "div", text: { tag: "lark_md", content: answer.textMd.trim() } });
  for (const key of imageKeys) {
    elements.push({ tag: "img", img_key: key, alt: { tag: "plain_text", content: "image" }, mode: "fit_horizontal" });
  }
  if (answer.sources.length) {
    const lines = answer.sources.map((s) => `• [${s.label}](${s.url})`).join("\n");
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**Sources:**\n${lines}` } });
  }
  if (elements.length === 0) elements.push({ tag: "div", text: { tag: "lark_md", content: " " } });

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "Answer" } },
    elements,
  };
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const d = (await res.json().catch(() => ({}))) as { code?: number };
  if (d.code !== 0) {
    console.error(`Lark answer card send failed: ${JSON.stringify(d)}`);
    // Fallback (req 9: raw URLs only if hyperlink rendering fails).
    const srcTxt = answer.sources.length
      ? `\n\nSources:\n${answer.sources.map((s) => `${s.label} (${s.url})`).join("\n")}`
      : "";
    await sendLarkMessage(env, openId, answer.text.trim() + srcTxt);
  }
}

/** Send the brand picker as a Lark interactive card. Button taps arrive as a card
 *  action callback (handled separately once the card callback URL is configured). */
export async function sendLarkBrandSelection(env: Env, openId: string): Promise<void> {
  const token = await tenantToken(env);
  const card = {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: BRAND_PROMPT } },
      {
        tag: "action",
        actions: BRAND_OPTIONS.map((b) => ({
          tag: "button",
          text: { tag: "plain_text", content: b.label },
          type: "primary",
          value: { brand_key: b.key },
        })),
      },
    ],
  };
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const d = (await res.json().catch(() => ({}))) as { code?: number };
  if (d.code !== 0) console.error(`Lark card send failed: ${JSON.stringify(d)}`);
}

interface LarkEvent {
  type?: string; // legacy "url_verification"
  challenge?: string;
  token?: string; // legacy token location
  header?: { event_type?: string; token?: string; event_id?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: { message_type?: string; content?: string; chat_type?: string };
  };
}

interface LarkCardCallback {
  type?: string; // "url_verification"
  challenge?: string;
  token?: string; // v1 token location
  open_id?: string; // v1: who tapped
  action?: { value?: { brand_key?: string }; tag?: string }; // v1: button payload
  header?: { token?: string; event_id?: string };
  event?: {
    operator?: { open_id?: string };
    action?: { value?: { brand_key?: string } };
  };
}

export async function handleLarkWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // 3) De-dupe: Lark re-delivers an event if we don't ack within ~3s (retries reuse event_id).
  const eventId = body.header?.event_id;
  if (eventId && (await alreadyProcessedEvent(env, eventId))) return json({ code: 0 });

  // 4) Inbound message — process in the background so we ACK Lark immediately (avoids retries).
  if (body.header?.event_type === "im.message.receive_v1") {
    const sender = body.event?.sender;
    const openId = sender?.sender_id?.open_id;
    const msg = body.event?.message;
    // Ignore non-user senders (e.g. our own bot) to avoid loops.
    if (openId && sender?.sender_type !== "app" && msg?.message_type === "text") {
      const text = (safeParse(msg.content) as { text?: string }).text?.trim() ?? "";
      const clean = stripMentions(text);
      if (clean) ctx.waitUntil(processLarkText(env, openId, clean));
    }
  }

  return json({ code: 0 });
}

/**
 * Card-action callback (interactive card button tap). Lark delivers these to a
 * SEPARATE URL from message events, as `card.action.trigger`. We accept both the
 * legacy shape (open_id + action.value at the top level) and the v2 shape
 * (header.event_type + event.operator.open_id + event.action.value) defensively.
 */
export async function handleLarkCardCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as LarkCardCallback | null;
  if (!body) return new Response("bad json", { status: 400 });

  // 1) URL verification handshake (sent when you set the card callback URL).
  if (body.type === "url_verification") return json({ challenge: body.challenge });

  // 2) Verify the verification token (v1 top-level, v2 in header).
  const token = body.token ?? body.header?.token;
  if (token !== env.LARK_VERIFICATION_TOKEN) {
    console.warn("LARK_CARD_TOKEN_FAIL");
    return new Response("invalid token", { status: 401 });
  }

  // 3) De-dupe retries (only the v2 shape carries an event_id).
  const eventId = body.header?.event_id;
  if (eventId && (await alreadyProcessedEvent(env, `card-${eventId}`))) return json({});

  // 4) Extract who tapped + which brand. Ack fast; do the work in the background.
  const openId = body.open_id ?? body.event?.operator?.open_id;
  const value = body.action?.value ?? body.event?.action?.value ?? {};
  const brand = brandByKey(value.brand_key ?? "");
  if (openId && brand) {
    ctx.waitUntil(
      (async () => {
        await setBrand(env, "lark", openId, brand.value);
        await sendLarkMessage(
          env,
          openId,
          `✅ 已选择 ${brand.label}。请问有什么可以帮您？ / Selected ${brand.label} — how can I help?`,
        );
      })(),
    );
  }
  return json({});
}

/** Handle one inbound Lark text message (runs after we've already acked Lark). */
async function processLarkText(env: Env, openId: string, clean: string): Promise<void> {
  if (/^\/(reset|new|clear)\b/i.test(clean)) {
    await resetChannel(env, "lark", openId);
    await sendLarkMessage(env, openId, "🔄 Fresh start — send a new message and we'll help again.");
    return;
  }
  if (/^\/start\b/i.test(clean)) {
    await sendLarkMessage(env, openId, "👋 Hi! Ask me anything about KYC, deposits, or withdrawals. Type /reset to start over.");
    return;
  }
  await routeInbound(env, "lark", openId, clean);
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
