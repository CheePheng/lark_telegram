/**
 * Standard Intercom Conversations REST client (uses INTERCOM_API_TOKEN), plus
 * the handoff orchestration. Used when Fin escalates: we open a real inbox
 * conversation so a human can take over, and bridge messages both ways.
 *
 * Verified shapes (Intercom 2.14):
 *   POST /contacts                         {role:"user", external_id, name}
 *   POST /conversations                    {from:{type:"user",id}, body}
 *   POST /conversations/{id}/reply         {message_type:"comment", type:"user", intercom_user_id, body}
 */
import type { Env } from "./env";
import type { Channel } from "./kv";
import {
  getContactId, setContactId, clearContactId, setHandoff, clearHandoff,
  getCanonicalConversation, setCanonicalConversation, clearCanonicalConversation, type CanonicalConversation,
  getWorkflowConversation, setWorkflowConversation, clearWorkflowConversation, alreadyRelayedPart,
} from "./kv";
import { sendToChannel } from "./channels";
import { htmlToPlainText } from "./html";

function headers(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.INTERCOM_API_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Intercom-Version": env.INTERCOM_API_VERSION,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Admin (Ask Ada) used to author the summary note and own the handoff conversation. */
const HANDOFF_ADMIN_ID = "9114500";

/** Human-friendly channel label and contact name. */
function channelLabel(channel: Channel): string {
  return channel === "telegram" ? "Telegram" : "Lark";
}
function contactName(channel: Channel): string {
  return `IGaming ${channelLabel(channel)}`;
}

/** Return a cached contact id for the channel-user, creating one if needed. */
export async function ensureContact(env: Env, channel: Channel, cuid: string): Promise<string> {
  const cached = await getContactId(env, channel, cuid);
  if (cached) {
    await renameContact(env, cached, contactName(channel)); // keep the display name current
    return cached;
  }

  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ role: "user", external_id: `${channel}_${cuid}`, name: contactName(channel) }),
  });

  let id: string | null = null;
  if (res.ok) {
    id = ((await res.json()) as { id?: string }).id ?? null;
  } else {
    id = await findContactByExternalId(env, `${channel}_${cuid}`); // probably already exists
  }
  if (!id) throw new Error(`ensureContact failed: ${res.status} ${await res.text().catch(() => "")}`);
  await setContactId(env, channel, cuid, id);
  return id;
}

async function renameContact(env: Env, contactId: string, name: string): Promise<void> {
  await fetch(`${env.INTERCOM_BASE_URL}/contacts/${contactId}`, {
    method: "PUT",
    headers: headers(env),
    body: JSON.stringify({ name }),
  }).catch(() => {});
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

/** Assign the conversation to an admin so it shows in their "Your inbox". */
async function assignConversation(env: Env, conversationId: string, adminId: string): Promise<void> {
  await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}/parts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ message_type: "assignment", type: "admin", admin_id: adminId, assignee_id: adminId }),
  }).catch(() => {});
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Post an internal (admin-only) note. Notes are NOT `comment` parts, so they
 *  never trigger conversation.admin.replied and are never relayed to the channel. */
async function addNote(env: Env, conversationId: string, html: string): Promise<void> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}/reply`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ message_type: "note", type: "admin", admin_id: HANDOFF_ADMIN_ID, body: html }),
  });
  if (!res.ok) console.error(`addNote failed: ${res.status} ${await res.text().catch(() => "")}`);
}

// ===========================================================================
// Canonical conversation — the ONE replyable Intercom conversation per
// {channel, cuid}. Customer messages + Fin answers are mirrored here so the
// agent has full context and one place to reply. Fin's own Fin-Agent-API thread
// stays read-only ("external system"); we never reply there — mirroring into the
// canonical "IGaming <Channel>" conversation is the supported workaround.
// ===========================================================================

/** Create a fresh canonical conversation (self-healing a stale contact) and store it. */
async function createCanonical(env: Env, channel: Channel, cuid: string, openingHtml: string): Promise<CanonicalConversation> {
  let contactId = await ensureContact(env, channel, cuid);
  let conversationId: string;
  try {
    conversationId = await createConversation(env, contactId, openingHtml);
  } catch {
    // Cached contact may be stale (e.g. created in a different workspace) -> recreate and retry.
    await clearContactId(env, channel, cuid);
    contactId = await ensureContact(env, channel, cuid);
    conversationId = await createConversation(env, contactId, openingHtml);
  }
  const rec: CanonicalConversation = {
    conversation_id: conversationId,
    contact_id: contactId,
    state: "ai",
    updated_at: new Date().toISOString(),
  };
  await setCanonicalConversation(env, channel, cuid, rec);
  return rec;
}

/** Return the canonical conversation, creating one if none exists yet. */
export async function ensureCanonicalConversation(env: Env, channel: Channel, cuid: string, seedText?: string): Promise<CanonicalConversation> {
  const existing = await getCanonicalConversation(env, channel, cuid);
  if (existing) return existing;
  const opening = seedText
    ? escapeHtml(seedText)
    : `Conversation mirrored from ${channelLabel(channel)}.`;
  return createCanonical(env, channel, cuid, opening);
}

/** Mirror an inbound customer message into the canonical conversation (as the contact). */
export async function mirrorCustomerToIntercom(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  const existing = await getCanonicalConversation(env, channel, cuid);
  if (!existing) {
    await createCanonical(env, channel, cuid, escapeHtml(text)); // first message becomes the opening
    return;
  }
  try {
    await replyAsUser(env, existing.conversation_id, existing.contact_id, text); // reopens if it was closed
  } catch {
    // Conversation deleted/unusable -> recreate with this message as the opening.
    await clearCanonicalConversation(env, channel, cuid, existing.conversation_id);
    await createCanonical(env, channel, cuid, escapeHtml(text));
  }
}

/** Mirror a Fin answer into the canonical conversation as an internal note (never relayed back). */
export async function mirrorFinToIntercom(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  const canon = await ensureCanonicalConversation(env, channel, cuid);
  await addNote(env, canon.conversation_id, `<p>🤖 <b>Fin (AI)</b><br>${escapeHtml(text).replace(/\n+/g, "<br>")}</p>`);
}

/** Switch the canonical conversation into human mode: note + assign + open handoff. No new conversation. */
export async function useCanonicalForHandoff(env: Env, channel: Channel, cuid: string, lastQuestion: string): Promise<void> {
  const canon = await ensureCanonicalConversation(env, channel, cuid, lastQuestion);
  await addNote(
    env,
    canon.conversation_id,
    `<p>🙋 <b>Customer requested human support.</b><br>Reply in <b>this</b> conversation — your replies are sent back to ${channelLabel(channel)}. (Fin's AI answers above are internal notes.)</p>`,
  );
  await assignConversation(env, canon.conversation_id, HANDOFF_ADMIN_ID); // lands in the agent's inbox
  await setHandoff(env, channel, cuid, { conversation_id: canon.conversation_id, contact_id: canon.contact_id, state: "open" });
  await setCanonicalConversation(env, channel, cuid, { ...canon, state: "human", updated_at: new Date().toISOString() });
  await sendToChannel(env, channel, cuid, "🔔 You're now connected to our team — an agent will reply right here.");
}

/** Agent closed the conversation: end human mode but KEEP the canonical conversation
 *  (and its icid mapping) so the customer's next message reuses it back under Fin. */
export async function endHandoff(env: Env, channel: Channel, cuid: string): Promise<void> {
  await clearHandoff(env, channel, cuid);
  const canon = await getCanonicalConversation(env, channel, cuid);
  if (canon) await setCanonicalConversation(env, channel, cuid, { ...canon, state: "ai", updated_at: new Date().toISOString() });
}

// ===========================================================================
// Workflow Bridge — the Lark/Telegram message IS a normal Intercom conversation.
// We tag the contact with source_channel so an Intercom Workflow can target it
// and let Fin answer in-thread. (Fin's own Fin-Agent-API thread is NOT used here.)
// ===========================================================================

/** Ensure a contact tagged with source_channel=<channel> so the Workflow audience matches. */
export async function ensureWorkflowContact(env: Env, channel: Channel, cuid: string): Promise<string> {
  const attrs = { custom_attributes: { source_channel: channel }, name: contactName(channel) };
  const cached = await getContactId(env, channel, cuid);
  if (cached) {
    await fetch(`${env.INTERCOM_BASE_URL}/contacts/${cached}`, {
      method: "PUT",
      headers: headers(env),
      body: JSON.stringify(attrs),
    }).catch(() => {});
    return cached;
  }
  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ role: "user", external_id: `${channel}_${cuid}`, ...attrs }),
  });
  let id: string | null = null;
  if (res.ok) id = ((await res.json()) as { id?: string }).id ?? null;
  else id = await findContactByExternalId(env, `${channel}_${cuid}`);
  if (!id) throw new Error(`ensureWorkflowContact failed: ${res.status} ${await res.text().catch(() => "")}`);
  await setContactId(env, channel, cuid, id);
  return id;
}

/** Poll the workflow conversation for new Fin (bot) / agent (admin) comments and relay them.
 *  Needed because Fin's *bot* replies do NOT fire conversation.admin.replied (only human replies do).
 *  Runs inside the inbound ctx.waitUntil, so a few seconds of polling is fine. Deduped with the
 *  webhook via alreadyRelayedPart, so a human reply caught by both is still sent once. */
export async function pollAndRelayWorkflow(env: Env, channel: Channel, cuid: string): Promise<void> {
  const wf = await getWorkflowConversation(env, channel, cuid);
  if (!wf) return;
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${wf.conversation_id}?display_as=plaintext`, { headers: headers(env) });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      conversation_parts?: { conversation_parts?: Array<{ id?: string; part_type?: string; body?: string; author?: { type?: string } }> };
    };
    const parts = data.conversation_parts?.conversation_parts ?? [];
    for (const p of parts) {
      if (p.part_type !== "comment") continue;
      const at = p.author?.type ?? "";
      if (at !== "bot" && at !== "admin") continue;
      if (!p.body) continue;
      if (p.id && (await alreadyRelayedPart(env, p.id))) continue;
      const prefix = at === "admin" ? "👤 " : ""; // Fin answers plain; human prefixed
      await sendToChannel(env, channel, cuid, `${prefix}${htmlToPlainText(String(p.body))}`);
    }
  }
}

/** First message → create the conversation (Workflow + Fin engage). Later messages → reply as the contact. */
export async function ensureWorkflowConversation(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  const existing = await getWorkflowConversation(env, channel, cuid);
  if (existing) {
    try {
      await replyAsUser(env, existing.conversation_id, existing.contact_id, text); // reopens if it was closed
      return;
    } catch {
      await clearWorkflowConversation(env, channel, cuid, existing.conversation_id); // gone -> recreate below
    }
  }
  let contactId = await ensureWorkflowContact(env, channel, cuid);
  let conversationId: string;
  try {
    conversationId = await createConversation(env, contactId, escapeHtml(text));
  } catch {
    // Cached contact may be stale (e.g. different workspace) -> recreate and retry.
    await clearContactId(env, channel, cuid);
    contactId = await ensureWorkflowContact(env, channel, cuid);
    conversationId = await createConversation(env, contactId, escapeHtml(text));
  }
  await setWorkflowConversation(env, channel, cuid, {
    conversation_id: conversationId,
    contact_id: contactId,
    updated_at: new Date().toISOString(),
  });
}
