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
// The reverse `icid:` lookup is owned by the canonical conversation
// (set/cleared via set/clearCanonicalConversation). The handoff record is just an
// "is a human handling this?" flag, so we do NOT touch `icid:` here — that keeps
// agent replies routable even after a handoff ends.
export async function setHandoff(env: Env, channel: Channel, cuid: string, h: Handoff): Promise<void> {
  await env.TG_FIN_STATE.put(`handoff:${channel}:${cuid}`, JSON.stringify(h));
}
export async function clearHandoff(env: Env, channel: Channel, cuid: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`handoff:${channel}:${cuid}`);
}
export async function getUserByIntercomConversation(env: Env, conversationId: string): Promise<UserRef | null> {
  return env.TG_FIN_STATE.get<UserRef>(`icid:${conversationId}`, "json");
}

// --- canonical Intercom conversation ---------------------------------------
// ONE replyable Intercom conversation per {channel, cuid} ("IGaming Lark" /
// "IGaming Telegram"). Customer messages + Fin answers are mirrored into it so
// the agent has full context in a single place. (Fin's own Fin-Agent-API thread
// stays read-only "external system" — we never reply there; this is the
// supported workaround.) `state` tracks our handling mode for that customer.
export interface CanonicalConversation {
  conversation_id: string;
  contact_id: string;
  state: "ai" | "human" | "closed";
  updated_at: string;
}

export async function getCanonicalConversation(env: Env, channel: Channel, cuid: string): Promise<CanonicalConversation | null> {
  return env.TG_FIN_STATE.get<CanonicalConversation>(`canonical:${channel}:${cuid}`, "json");
}

/** Store the canonical record and keep the reverse `icid` lookup in sync. */
export async function setCanonicalConversation(env: Env, channel: Channel, cuid: string, rec: CanonicalConversation): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`canonical:${channel}:${cuid}`, JSON.stringify(rec)),
    env.TG_FIN_STATE.put(`icid:${rec.conversation_id}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}

export async function clearCanonicalConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`canonical:${channel}:${cuid}`),
    env.TG_FIN_STATE.delete(`icid:${conversationId}`),
  ]);
}

// --- workflow-bridge conversation -----------------------------------------
// The Lark/Telegram message IS this Intercom conversation (created via the
// Conversations API). An Intercom Workflow runs Fin inside it; agents reply in
// it; we relay replies back. (Distinct from the canonical-mirror records.)
export interface WorkflowConversation {
  conversation_id: string;
  contact_id: string;
  updated_at: string;
}

export async function getWorkflowConversation(env: Env, channel: Channel, cuid: string): Promise<WorkflowConversation | null> {
  return env.TG_FIN_STATE.get<WorkflowConversation>(`wf:${channel}:${cuid}`, "json");
}

/** Store the workflow conversation and keep the reverse `icid` lookup in sync. */
export async function setWorkflowConversation(env: Env, channel: Channel, cuid: string, rec: WorkflowConversation): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`wf:${channel}:${cuid}`, JSON.stringify(rec)),
    env.TG_FIN_STATE.put(`icid:${rec.conversation_id}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}

export async function clearWorkflowConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`wf:${channel}:${cuid}`),
    env.TG_FIN_STATE.delete(`icid:${conversationId}`),
  ]);
}

/** Clear only the forward mapping (next message starts a fresh conversation) but KEEP `icid`,
 *  so an in-flight Fin/agent reply to the old conversation can still be relayed. Used by /reset. */
export async function clearWorkflowForward(env: Env, channel: Channel, cuid: string): Promise<void> {
  await env.TG_FIN_STATE.delete(`wf:${channel}:${cuid}`);
}

// --- Intercom webhook dedupe (loop protection) -----------------------------
const PART_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/** True if this Intercom conversation-part was already relayed (records it if not). */
export async function alreadyRelayedPart(env: Env, partId: string): Promise<boolean> {
  const k = `relayedpart:${partId}`;
  if (await env.TG_FIN_STATE.get(k)) return true;
  await env.TG_FIN_STATE.put(k, "1", { expirationTtl: PART_DEDUPE_TTL_SECONDS });
  return false;
}

/** True if this inbound channel event was already processed (records it if not).
 *  De-dupes at-least-once webhook delivery (e.g. Lark re-sends if we ack slowly). */
export async function alreadyProcessedEvent(env: Env, eventId: string): Promise<boolean> {
  const k = `evt:${eventId}`;
  if (await env.TG_FIN_STATE.get(k)) return true;
  await env.TG_FIN_STATE.put(k, "1", { expirationTtl: PART_DEDUPE_TTL_SECONDS });
  return false;
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
