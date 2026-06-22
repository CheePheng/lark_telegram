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

export async function getConversationId(env: Env, tgUserId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`conv:${tgUserId}`);
}

/** Stores both the forward (tg->conv) and reverse (conv->tg) mappings. */
export async function linkConversation(env: Env, tgUserId: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`conv:${tgUserId}`, conversationId),
    env.TG_FIN_STATE.put(`fin:${conversationId}`, tgUserId),
  ]);
}

export async function getTelegramByConversation(env: Env, conversationId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`fin:${conversationId}`);
}

/** Forget a finished conversation so the user's next message starts a fresh one. */
export async function clearConversation(env: Env, tgUserId: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`conv:${tgUserId}`),
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

export async function getContactId(env: Env, tgUserId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`contact:${tgUserId}`);
}
export async function setContactId(env: Env, tgUserId: string, contactId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`contact:${tgUserId}`, contactId);
}
export async function clearContactId(env: Env, tgUserId: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`contact:${tgUserId}`);
}
export async function getHandoff(env: Env, tgUserId: string): Promise<Handoff | null> {
  return env.TG_FIN_STATE.get<Handoff>(`handoff:${tgUserId}`, "json");
}
export async function setHandoff(env: Env, tgUserId: string, h: Handoff): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`handoff:${tgUserId}`, JSON.stringify(h)),
    env.TG_FIN_STATE.put(`icid:${h.conversation_id}`, tgUserId),
  ]);
}
export async function clearHandoff(env: Env, tgUserId: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`handoff:${tgUserId}`),
    env.TG_FIN_STATE.delete(`icid:${conversationId}`),
  ]);
}
export async function getTelegramByIntercomConversation(env: Env, conversationId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`icid:${conversationId}`);
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
export async function appendTranscript(env: Env, tgUserId: string, role: TranscriptEntry["role"], text: string): Promise<void> {
  const key = `transcript:${tgUserId}`;
  const cur = (await env.TG_FIN_STATE.get<TranscriptEntry[]>(key, "json")) ?? [];
  cur.push({ role, text });
  while (cur.length > TRANSCRIPT_MAX) cur.shift();
  await env.TG_FIN_STATE.put(key, JSON.stringify(cur), { expirationTtl: 7 * 24 * 60 * 60 });
}
export async function getTranscript(env: Env, tgUserId: string): Promise<TranscriptEntry[]> {
  return (await env.TG_FIN_STATE.get<TranscriptEntry[]>(`transcript:${tgUserId}`, "json")) ?? [];
}
export async function clearTranscript(env: Env, tgUserId: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`transcript:${tgUserId}`);
}
