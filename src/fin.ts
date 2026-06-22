/**
 * Intercom Fin Agent API client + webhook verification.
 *
 * Endpoints (Fin "over API" / custom channel):
 *   POST {INTERCOM_BASE_URL}/fin/start   - begin a Fin conversation
 *   POST {INTERCOM_BASE_URL}/fin/reply   - continue an existing conversation
 * Inbound webhook events: fin_replied, fin_status_updated (fin_reply_chunk is SSE-only).
 *
 * VERIFIED against the Intercom OpenAPI 2.14 spec AND a live 200 response from
 * the workspace on 2026-06-19. Request/response field names below are exact:
 *   request : { conversation_id, message:{author,body,timestamp}, user:{id,name?,email?,attributes?} }
 *   webhook : { event_name, conversation_id, user_id, message:{author,body,timestamp_ms}, status }
 * We choose `conversation_id` ourselves (derived from the Telegram user), so the
 * fin_replied webhook carries it straight back for routing.
 */
import type { Env } from "./env";
import { hmacSha256Hex, hmacSha256HexBytes, hexToBytes, safeEqual } from "./crypto";

export interface FinUserContext {
  /** Stable id for this user across the conversation (we use the Telegram user id). */
  userId: string;
  displayName?: string;
  memberId?: string;
  brandId?: string;
  language?: string;
  verified: boolean;
}

export type FinEvent =
  | { type: "fin_replied"; conversationId: string; userId?: string; replyHtml: string }
  | { type: "fin_status_updated"; conversationId: string; userId?: string; status?: string }
  | { type: "unknown" };

function finHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.INTERCOM_FIN_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Intercom-Version": env.INTERCOM_API_VERSION,
  };
}

/**
 * Send a user message to Fin. Starts a new conversation when `conversationId`
 * is null (generating a fresh id), otherwise replies on the existing one.
 * Returns the conversation id the caller should persist.
 */
export async function sendToFin(
  env: Env,
  ctx: FinUserContext,
  text: string,
  conversationId: string | null,
): Promise<{ conversationId: string; intercomConversationId?: string }> {
  // Continue the existing conversation if we have one...
  if (conversationId) {
    const replied = await postFin(env, "/fin/reply", conversationId, ctx, text);
    if (replied.ok) return { conversationId, intercomConversationId: replied.intercomConversationId };
    // ...but if Fin doesn't know it (e.g. after a workspace switch), start fresh.
    if (!replied.notFound) throw new Error(`Fin reply failed: ${replied.status} ${replied.detail}`);
  }
  const newId = newConversationId(ctx.userId);
  const started = await postFin(env, "/fin/start", newId, ctx, text);
  if (!started.ok) throw new Error(`Fin start failed: ${started.status} ${started.detail}`);
  return { conversationId: newId, intercomConversationId: started.intercomConversationId };
}

interface FinPostResult {
  ok: boolean;
  status: number;
  detail: string;
  notFound: boolean;
  intercomConversationId?: string;
}

async function postFin(
  env: Env,
  path: "/fin/start" | "/fin/reply",
  conversationId: string,
  ctx: FinUserContext,
  text: string,
): Promise<FinPostResult> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}${path}`, {
    method: "POST",
    headers: finHeaders(env),
    body: JSON.stringify(buildRequestBody(conversationId, ctx, text)),
  });
  const detail = await res.text().catch(() => "");
  let intercomConversationId: string | undefined;
  try {
    intercomConversationId = (JSON.parse(detail) as { intercom_conversation_id?: string }).intercom_conversation_id;
  } catch {
    /* error body may not be JSON */
  }
  const notFound = !res.ok && /conversation not found|not found for the given conversation_id/i.test(detail);
  return { ok: res.ok, status: res.status, detail, notFound, intercomConversationId };
}

/**
 * Verify the X-Fin-Agent-API-Webhook-Signature header (HMAC-SHA256 of the raw
 * body). Accepts the signing secret used either as a UTF-8 string key or as a
 * hex-decoded byte key, since Intercom's docs don't specify which.
 */
export async function verifyFinWebhookSignature(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  const secret = env.INTERCOM_FIN_WEBHOOK_SECRET;

  // Convention A: secret used directly as a UTF-8 string key.
  if (safeEqual(provided, await hmacSha256Hex(secret, rawBody))) return true;

  // Convention B: secret is hex, decoded to raw key bytes.
  const keyBytes = hexToBytes(secret);
  if (keyBytes && safeEqual(provided, await hmacSha256HexBytes(keyBytes, rawBody))) return true;

  return false;
}

// ===========================================================================
// Wire-format mapping (exact, per verified 2.14 spec). Same body for start/reply.
// ===========================================================================

function newConversationId(userId: string): string {
  return `tg-${userId}-${Date.now()}`;
}

function buildRequestBody(conversationId: string, ctx: FinUserContext, text: string): Record<string, unknown> {
  // Some workspaces require `timestamp`, newer ones require `timestamp_ms`; send both.
  const now = new Date().toISOString();
  return {
    conversation_id: conversationId,
    message: { author: "user", body: text, timestamp: now, timestamp_ms: now },
    user: { id: ctx.userId, name: ctx.displayName, attributes: attributesFor(ctx) },
  };
}

/**
 * Identity/context passed to Fin so Procedures can gate and answer account
 * questions. Define matching custom attributes in Intercom so they're recognized
 * (unknown attributes are reported in the response `errors` but are non-fatal).
 */
function attributesFor(ctx: FinUserContext): Record<string, unknown> {
  return {
    verified: ctx.verified,
    member_id: ctx.memberId ?? null,
    brand_id: ctx.brandId ?? null,
    language: ctx.language ?? null,
    channel: "telegram",
  };
}

/** Normalize an inbound Fin webhook payload into a FinEvent. */
export function parseFinWebhook(json: unknown): FinEvent {
  const o = json as Record<string, any> | null;
  if (!o) return { type: "unknown" };

  const name = asString(o.event_name) ?? "";
  const conversationId = asString(o.conversation_id) ?? "";
  const userId = asString(o.user_id) ?? undefined;

  if (name === "fin_replied") {
    return { type: "fin_replied", conversationId, userId, replyHtml: asString(o?.message?.body) ?? "" };
  }
  if (name === "fin_status_updated") {
    return { type: "fin_status_updated", conversationId, userId, status: asString(o.status) ?? undefined };
  }
  return { type: "unknown" };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
