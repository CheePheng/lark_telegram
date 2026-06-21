/**
 * Standard Intercom Conversations REST client (uses INTERCOM_API_TOKEN), plus
 * the handoff orchestration. Used when Fin escalates: we open a real inbox
 * conversation so a human can take over, and bridge messages both ways.
 *
 * Verified shapes (Intercom 2.14):
 *   POST /contacts                         {role:"user", external_id, name}
 *   POST /conversations                    {from:{type:"contact",id}, body}
 *   POST /conversations/{id}/reply         {message_type:"comment", type:"user", intercom_user_id, body}
 */
import type { Env } from "./env";
import { getContactId, setContactId, getHandoff, setHandoff } from "./kv";
import { sendTelegramMessage } from "./telegram";

function headers(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.INTERCOM_API_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Intercom-Version": env.INTERCOM_API_VERSION,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Return a cached contact id for the Telegram user, creating one if needed. */
export async function ensureContact(env: Env, tgUserId: string): Promise<string> {
  const cached = await getContactId(env, tgUserId);
  if (cached) return cached;

  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ role: "user", external_id: `tg_${tgUserId}`, name: `Telegram ${tgUserId}` }),
  });

  let id: string | null = null;
  if (res.ok) {
    id = ((await res.json()) as { id?: string }).id ?? null;
  } else {
    id = await findContactByExternalId(env, `tg_${tgUserId}`); // probably already exists
  }
  if (!id) throw new Error(`ensureContact failed: ${res.status} ${await res.text().catch(() => "")}`);
  await setContactId(env, tgUserId, id);
  return id;
}

async function findContactByExternalId(env: Env, externalId: string): Promise<string | null> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts/search`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ query: { field: "external_id", operator: "=", value: externalId } }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return data.data?.[0]?.id ?? null;
}

async function createConversation(env: Env, contactId: string, body: string): Promise<string> {
  let detail = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations`, {
      method: "POST",
      headers: headers(env),
      // NOTE: this workspace requires from.type "user" (not "contact"; that 404s here).
      body: JSON.stringify({ from: { type: "user", id: contactId }, body }),
    });
    if (res.ok) {
      const data = (await res.json()) as { conversation_id?: string; id?: string };
      const id = data.conversation_id ?? data.id;
      if (id) return id;
    }
    detail = await res.text().catch(() => "");
    if (res.status === 404) {
      await sleep(800); // contact just created; not yet queryable
      continue;
    }
    break;
  }
  throw new Error(`createConversation failed: ${detail}`);
}

/** Post the player's message into the inbox conversation as the contact. */
export async function replyAsUser(env: Env, conversationId: string, contactId: string, body: string): Promise<void> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}/reply`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ message_type: "comment", type: "user", intercom_user_id: contactId, body }),
  });
  if (!res.ok) throw new Error(`replyAsUser failed: ${res.status} ${await res.text().catch(() => "")}`);
}

/** Enter human mode: reuse an open handoff, or open a new inbox conversation. */
export async function startHandoff(env: Env, tgUserId: string, lastQuestion: string): Promise<void> {
  const existing = await getHandoff(env, tgUserId);
  if (existing?.state === "open") {
    await replyAsUser(env, existing.conversation_id, existing.contact_id, "(Customer asked to speak with a human again.)");
    await sendTelegramMessage(env, tgUserId, "You're already connected to our team — they'll reply here.");
    return;
  }
  const contactId = await ensureContact(env, tgUserId);
  const conversationId = await createConversation(
    env,
    contactId,
    `Escalated from Telegram. The customer would like to speak with a human.\nLast message: ${lastQuestion}`,
  );
  await setHandoff(env, tgUserId, { conversation_id: conversationId, contact_id: contactId, state: "open" });
  await sendTelegramMessage(env, tgUserId, "🔔 You're now connected to our team — an agent will reply right here.");
}
