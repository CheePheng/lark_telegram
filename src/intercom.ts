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
import { getContactId, setContactId, clearContactId, getHandoff, setHandoff, clearHandoff, getTranscript, type TranscriptEntry } from "./kv";
import { sendToChannel } from "./channels";

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

/** Enter human mode: reuse an open handoff, or open a new inbox conversation. */
export async function startHandoff(env: Env, channel: Channel, cuid: string, lastQuestion: string): Promise<void> {
  const existing = await getHandoff(env, channel, cuid);
  if (existing?.state === "open") {
    try {
      await replyAsUser(env, existing.conversation_id, existing.contact_id, "(Customer asked to speak with a human again.)");
      await sendToChannel(env, channel, cuid, "You're already connected to our team — they'll reply here.");
      return;
    } catch {
      await clearHandoff(env, channel, cuid, existing.conversation_id); // stale (e.g. old workspace) -> open a fresh one
    }
  }

  const transcript = await getTranscript(env, channel, cuid);
  const body = buildHandoffBody(channel, transcript, lastQuestion);
  let contactId = await ensureContact(env, channel, cuid);
  let conversationId: string;
  try {
    conversationId = await createConversation(env, contactId, body);
  } catch {
    // Cached contact may be stale (created in a different workspace) -> recreate and retry.
    await clearContactId(env, channel, cuid);
    contactId = await ensureContact(env, channel, cuid);
    conversationId = await createConversation(env, contactId, body);
  }
  await setHandoff(env, channel, cuid, { conversation_id: conversationId, contact_id: contactId, state: "open" });
  await addSummaryNote(env, conversationId, transcript);
  await assignConversation(env, conversationId, HANDOFF_ADMIN_ID); // so it lands in the agent's inbox
  await sendToChannel(env, channel, cuid, "🔔 You're now connected to our team — an agent will reply right here.");
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

/** A readable transcript seeded as the handoff conversation body, so the agent sees full context. */
function buildHandoffBody(channel: Channel, transcript: TranscriptEntry[], lastQuestion: string): string {
  const turns = transcript.length ? transcript : [{ role: "customer" as const, text: lastQuestion }];
  const rows = turns.map((t) => {
    const who = t.role === "customer" ? "🧑 Customer" : t.role === "fin" ? "🤖 Fin (AI)" : "👤 Agent";
    const text = escapeHtml(t.text).replace(/\n+/g, "<br>");
    return `<p><b>${who}</b><br>${text}</p>`;
  });
  return [
    `<p>🔔 <b>Escalated from ${channelLabel(channel)}</b> — the customer asked to speak with a human.</p>`,
    `<p>──────── Conversation so far ────────</p>`,
    ...rows,
  ].join("");
}

/** Post an internal note summarising the conversation for the agent. */
async function addSummaryNote(env: Env, conversationId: string, transcript: TranscriptEntry[]): Promise<void> {
  const customerMsgs = transcript.filter((t) => t.role === "customer").map((t) => t.text);
  const lastFin = [...transcript].reverse().find((t) => t.role === "fin")?.text;
  const note = [
    `<p>📋 <b>Summary (auto, from chat)</b></p>`,
    `<p><b>Question:</b> ${escapeHtml(customerMsgs[0] ?? "(unknown)")}</p>`,
    `<p><b>Customer messages:</b></p>`,
    `<ul>${(customerMsgs.length ? customerMsgs : ["(none)"]).map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`,
    `<p><b>Fin's last answer:</b> ${lastFin ? escapeHtml(lastFin.slice(0, 300)) : "(none)"}</p>`,
    `<p>⚠️ <b>Customer has requested a human agent.</b></p>`,
  ].join("");
  const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}/reply`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ message_type: "note", type: "admin", admin_id: HANDOFF_ADMIN_ID, body: note }),
  });
  if (!res.ok) console.error(`addSummaryNote failed: ${res.status} ${await res.text().catch(() => "")}`);
}
