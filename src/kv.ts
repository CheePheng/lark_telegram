/**
 * Typed Cloudflare KV helpers for all state this Worker keeps.
 *
 * Keys:
 *   tg:{telegram_user_id}   -> IdentityMapping (who this Telegram user is)
 *   conv:{telegram_user_id} -> fin_conversation_id (current Fin conversation)
 *   fin:{conversation_id}   -> telegram_user_id (reverse, to route Fin replies)
 *   verify:{state}          -> telegram_user_id (pending verification handshake, short TTL)
 */
import type { Env } from "./env";

/** Mirrors the doc's "Recommended Mapping Record". */
export interface IdentityMapping {
  telegram_user_id: string;
  member_id?: string;
  brand_id?: string;
  intercom_contact_id?: string;
  verified: boolean;
  verification_method?: string;
  language?: string;
  updated_at: string;
}

const VERIFY_STATE_TTL_SECONDS = 15 * 60; // 15 minutes

export async function getMapping(env: Env, tgUserId: string): Promise<IdentityMapping | null> {
  return env.TG_FIN_STATE.get<IdentityMapping>(`tg:${tgUserId}`, "json");
}

export async function putMapping(env: Env, mapping: IdentityMapping): Promise<void> {
  mapping.updated_at = new Date().toISOString();
  await env.TG_FIN_STATE.put(`tg:${mapping.telegram_user_id}`, JSON.stringify(mapping));
}

// --- channel identity -------------------------------------------------------
/** The customer channels we bridge to Fin. */
export type Channel = "telegram" | "lark";
/** Identifies a customer: which channel + their id within that channel. */
export interface UserRef {
  channel: Channel;
  cuid: string;
}

// --- Fin conversation per channel-user --------------------------------------

export async function getFinConversation(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`conv:${channel}:${cuid}`);
}

/** Stores both the forward (user->conv) and reverse (conv->user) mappings. */
export async function linkFinConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`conv:${channel}:${cuid}`, conversationId),
    env.TG_FIN_STATE.put(`fin:${conversationId}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}

export async function getUserByFinConversation(env: Env, conversationId: string): Promise<UserRef | null> {
  return env.TG_FIN_STATE.get<UserRef>(`fin:${conversationId}`, "json");
}

/** Forget a finished conversation so the user's next message starts a fresh one. */
export async function clearFinConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`conv:${channel}:${cuid}`),
    env.TG_FIN_STATE.delete(`fin:${conversationId}`),
  ]);
}

// --- verification handshake ------------------------------------------------

export async function putVerifyState(env: Env, state: string, tgUserId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`verify:${state}`, tgUserId, { expirationTtl: VERIFY_STATE_TTL_SECONDS });
}

export async function consumeVerifyState(env: Env, state: string): Promise<string | null> {
  const key = `verify:${state}`;
  const tgUserId = await env.TG_FIN_STATE.get(key);
  if (tgUserId) await env.TG_FIN_STATE.delete(key);
  return tgUserId;
}

// --- human handoff ---------------------------------------------------------

/** An active handoff to a human in the Intercom inbox. Presence + state "open" = human mode. */
export interface Handoff {
  conversation_id: string;
  contact_id: string;
  state: "open";
}

export async function getContactId(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`contact:${channel}:${cuid}`);
}
export async function setContactId(env: Env, channel: Channel, cuid: string, contactId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`contact:${channel}:${cuid}`, contactId);
}
export async function clearContactId(env: Env, channel: Channel, cuid: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`contact:${channel}:${cuid}`);
}
export async function getHandoff(env: Env, channel: Channel, cuid: string): Promise<Handoff | null> {
  return env.TG_FIN_STATE.get<Handoff>(`handoff:${channel}:${cuid}`, "json");
}
export async function setHandoff(env: Env, channel: Channel, cuid: string, h: Handoff): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`handoff:${channel}:${cuid}`, JSON.stringify(h)),
    env.TG_FIN_STATE.put(`icid:${h.conversation_id}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}
export async function clearHandoff(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`handoff:${channel}:${cuid}`),
    env.TG_FIN_STATE.delete(`icid:${conversationId}`),
  ]);
}
export async function getUserByIntercomConversation(env: Env, conversationId: string): Promise<UserRef | null> {
  return env.TG_FIN_STATE.get<UserRef>(`icid:${conversationId}`, "json");
}

// --- Lark escalation dedupe ------------------------------------------------
const LARK_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/** True if this case+exception was already escalated to Lark (records it if not). */
export async function alreadyEscalatedToLark(env: Env, dedupeKey: string): Promise<boolean> {
  const k = `larktask:${dedupeKey}`;
  const existing = await env.TG_FIN_STATE.get(k);
  if (existing) return true;
  await env.TG_FIN_STATE.put(k, new Date().toISOString(), { expirationTtl: LARK_DEDUPE_TTL_SECONDS });
  return false;
}

// --- handoff transcript (for context + summary note) -----------------------
const TRANSCRIPT_MAX = 20;
export type TranscriptEntry = { role: "customer" | "fin" | "agent"; text: string };

/** Append a line to the per-user transcript (keeps the last TRANSCRIPT_MAX). */
export async function appendTranscript(env: Env, channel: Channel, cuid: string, role: TranscriptEntry["role"], text: string): Promise<void> {
  const key = `transcript:${channel}:${cuid}`;
  const cur = (await env.TG_FIN_STATE.get<TranscriptEntry[]>(key, "json")) ?? [];
  cur.push({ role, text });
  while (cur.length > TRANSCRIPT_MAX) cur.shift();
  await env.TG_FIN_STATE.put(key, JSON.stringify(cur), { expirationTtl: 7 * 24 * 60 * 60 });
}
export async function getTranscript(env: Env, channel: Channel, cuid: string): Promise<TranscriptEntry[]> {
  return (await env.TG_FIN_STATE.get<TranscriptEntry[]>(`transcript:${channel}:${cuid}`, "json")) ?? [];
}
export async function clearTranscript(env: Env, channel: Channel, cuid: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`transcript:${channel}:${cuid}`);
}

// --- Lark tenant-access-token cache ----------------------------------------

/** Returns the cached Lark tenant token if it's still valid (with 60s headroom). */
export async function getCachedLarkToken(env: Env): Promise<string | null> {
  const v = await env.TG_FIN_STATE.get<{ token: string; exp: number }>("lark_tenant_token", "json");
  return v && v.exp > Math.floor(Date.now() / 1000) + 60 ? v.token : null;
}
export async function setCachedLarkToken(env: Env, token: string, sec: number): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + sec;
  await env.TG_FIN_STATE.put("lark_tenant_token", JSON.stringify({ token, exp }), { expirationTtl: sec });
}
