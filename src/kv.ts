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
