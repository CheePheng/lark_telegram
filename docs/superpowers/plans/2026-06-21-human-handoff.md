# Human Handoff Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. This project has **no unit-test harness**; it is integration-bound, so each task is verified by **`npm run typecheck` + live API/Telegram checks** (the practical equivalent of tests here). Keep code complete and commit per task.

**Goal:** When Fin escalates, create a real Intercom **inbox** conversation a human can see and reply to, bridge the human's replies back to the player on Telegram (and the player's follow-ups back into the inbox), and cleanly return to Fin when the chat closes.

**Architecture:** The Fin Agent API hands control back to us on escalation (it does **not** populate the inbox itself). So on the `escalated` event our Worker uses the **standard Intercom Conversations API** to open an inbox conversation as the player's contact, and subscribes to the **standard webhook** (`conversation.admin.replied`, `conversation.admin.closed`) to relay the human's replies and closure. A per-user **mode** (fin ↔ human) routes messages to the right place.

**Tech Stack:** Cloudflare Workers + KV, Intercom Conversations REST API (v2.14) + standard webhooks (X-Hub-Signature SHA1), Telegram Bot API.

---

## Why the earlier test showed nothing in the inbox
The Fin Agent API is "Fin embedded in your product." On escalation it fires `fin_status_updated: escalated` and returns control to the client — it never creates an Intercom inbox conversation. So human handoff must be bridged by us. (Verified: bot said "escalated" but the inbox stayed empty.)

## Conversation lifecycle (answers "new vs. same inbox conversation?")
- **One open human conversation per Telegram user at a time.**
- **Escalation** → if the user already has an **open** handoff, **reuse** it (post a note, no duplicate). If none/closed, **create a new** inbox conversation.
- **Repeat "talk to a human"** during an active handoff → **same** inbox conversation.
- **After the agent closes it** (or after `/reset`) → handoff is cleared, user returns to Fin → the **next** escalation opens a **fresh** inbox conversation.
- **`/reset`** during a handoff → ends the handoff on our side (returns the player to Fin) and notifies them.

## State (Cloudflare KV)
- `contact:{tgUserId}` → Intercom contact id (cached, so we don't recreate).
- `handoff:{tgUserId}` → `{ conversation_id, contact_id, state: "open" }` (presence with `state:"open"` = **human mode**).
- `icid:{conversation_id}` → `tgUserId` (reverse, to route inbox webhooks back).

## Secrets (new)
- `INTERCOM_API_TOKEN` — general REST token (read+write **Conversations** and **Contacts**) from the **new** workspace. (The Fin Agent key is scoped to `/fin/*` only and cannot do this.)
- `INTERCOM_CLIENT_SECRET` — the Developer Hub app's client secret, to verify the standard webhook `X-Hub-Signature` (SHA1).

## Files
| File | Change |
|---|---|
| `src/env.ts` | add `INTERCOM_API_TOKEN`, `INTERCOM_CLIENT_SECRET` |
| `src/kv.ts` | add contact/handoff/icid helpers |
| `src/intercom.ts` | **new** — Conversations REST client + `ensureContact` + `startHandoff` |
| `src/intercomwebhook.ts` | **new** — standard webhook: human reply → Telegram, close → back to Fin |
| `src/finwebhook.ts` | on `escalated` → `startHandoff` (instead of just messaging) |
| `src/telegram.ts` | route messages by mode; `/reset` ends a handoff |
| `src/index.ts` | route `POST /intercom/webhook` |

---

## Task 1: Provision Intercom REST access (dashboard + secrets)

- [ ] **Step 1 (user) — General API token.** In the **new** workspace: Settings → **API tokens** (or a Developer Hub app) → create/copy a token with **read & write** for **Conversations** and **Contacts/People**. This becomes `INTERCOM_API_TOKEN`.
- [ ] **Step 2 (user) — Standard webhook.** In the new workspace **Developer Hub → your app → Webhooks**: set Endpoint URL to `https://tg-fin-bridge.askada.workers.dev/intercom/webhook`; under **Configure → Authentication** grant the conversation read permission; subscribe to topics **`conversation.admin.replied`** and **`conversation.admin.closed`**. Copy the app **Client secret** (Basic information) → `INTERCOM_CLIENT_SECRET`.
- [ ] **Step 3 — Set the secrets** (file method, avoids CRLF):
```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"
$json = @'
{ "INTERCOM_API_TOKEN": "PASTE_GENERAL_TOKEN", "INTERCOM_CLIENT_SECRET": "PASTE_CLIENT_SECRET" }
'@
$p = Join-Path $env:TEMP "k.json"; [System.IO.File]::WriteAllText($p,$json)
npx wrangler secret bulk $p; Remove-Item $p -Force
```
Expected: `2 secrets successfully uploaded`.

## Task 2: Verify the Conversations API works (live, before coding)

- [ ] **Step 1 — Create a contact, conversation, and reply** with the general token (substitute it). Run in Git Bash:
```bash
T="PASTE_GENERAL_TOKEN"; H="-H \"Authorization: Bearer $T\" -H \"Intercom-Version: 2.14\" -H \"Content-Type: application/json\""
CID=$(curl -s -X POST https://api.intercom.io/contacts -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" -H "Content-Type: application/json" -d '{"role":"user","external_id":"tg_verify_1","name":"Telegram verify"}' | grep -o '"id":"[a-f0-9]*"' | head -1 | sed 's/.*:"//;s/"//')
echo "contact=$CID"
curl -s -X POST https://api.intercom.io/conversations -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" -H "Content-Type: application/json" -d "{\"from\":{\"type\":\"contact\",\"id\":\"$CID\"},\"body\":\"handoff verify test\"}" -w "\nHTTP %{http_code}\n"
```
Expected: contact id printed, conversation create returns `HTTP 200` with a `conversation_id`. **Confirm it appears in the Intercom inbox.** (If `404 Contact Not Found`, it's eventual consistency — the code in Task 4 retries.)

## Task 3: env + KV helpers

- [ ] **Step 1 — `src/env.ts`:** add two fields to `Env`:
```typescript
  INTERCOM_API_TOKEN: string;
  INTERCOM_CLIENT_SECRET: string;
```
- [ ] **Step 2 — `src/kv.ts`:** append:
```typescript
export interface Handoff { conversation_id: string; contact_id: string; state: "open" }

export async function getContactId(env: Env, tgUserId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`contact:${tgUserId}`);
}
export async function setContactId(env: Env, tgUserId: string, contactId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`contact:${tgUserId}`, contactId);
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
```
- [ ] **Step 3 — Verify:** `npm run typecheck` → no errors.

## Task 4: Intercom REST client (`src/intercom.ts`)

- [ ] **Step 1 — Create the file:**
```typescript
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
    id = await findContactByExternalId(env, `tg_${tgUserId}`); // already exists
  }
  if (!id) throw new Error("ensureContact: could not create or find contact");
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
      body: JSON.stringify({ from: { type: "contact", id: contactId }, body }),
    });
    if (res.ok) {
      const data = (await res.json()) as { conversation_id?: string; id?: string };
      const id = data.conversation_id ?? data.id;
      if (id) return id;
    }
    detail = await res.text().catch(() => "");
    if (res.status === 404) { await sleep(800); continue; } // contact not yet queryable
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

/** Enter human mode: reuse an open handoff or open a new inbox conversation. */
export async function startHandoff(env: Env, tgUserId: string, lastQuestion: string): Promise<void> {
  const existing = await getHandoff(env, tgUserId);
  if (existing?.state === "open") {
    await replyAsUser(env, existing.conversation_id, existing.contact_id, "(Customer asked to speak with a human again.)");
    await sendTelegramMessage(env, tgUserId, "You're already connected to our team — they'll reply here.");
    return;
  }
  const contactId = await ensureContact(env, tgUserId);
  const conversationId = await createConversation(
    env, contactId,
    `Escalated from Telegram. The customer would like to speak with a human.\nLast message: ${lastQuestion}`,
  );
  await setHandoff(env, tgUserId, { conversation_id: conversationId, contact_id: contactId, state: "open" });
  await sendTelegramMessage(env, tgUserId, "🔔 You're now connected to our team — an agent will reply right here.");
}
```
- [ ] **Step 2 — Verify:** `npm run typecheck` → no errors.

## Task 5: Escalation → start handoff (`src/finwebhook.ts`)

- [ ] **Step 1 — Import** at top: `import { startHandoff } from "./intercom";`
- [ ] **Step 2 — Replace the `fin_status_updated` block** so `escalated` opens the handoff:
```typescript
  if (event.type === "fin_status_updated") {
    const tgUserId = await getTelegramByConversation(env, event.conversationId);
    if (tgUserId && event.status === "escalated") {
      await startHandoff(env, tgUserId, "(escalation requested)");
    }
    if (tgUserId && (event.status === "escalated" || event.status === "resolved" || event.status === "complete")) {
      await clearConversation(env, tgUserId, event.conversationId); // end the Fin thread
    }
    return ok();
  }
```
- [ ] **Step 3 — Verify + deploy:** `npm run typecheck`; `npx wrangler deploy`.

## Task 6: Mode-aware Telegram routing (`src/telegram.ts`)

- [ ] **Step 1 — Imports:** add `import { getHandoff, clearHandoff } from "./kv";` and `import { replyAsUser } from "./intercom";`
- [ ] **Step 2 — In `handleTelegramWebhook`, make `/reset` end a handoff.** Replace the `/reset` block:
```typescript
    if (text.startsWith("/reset") || text.startsWith("/new") || text.startsWith("/clear")) {
      const handoff = await getHandoff(env, tgUserId);
      if (handoff?.state === "open") {
        await clearHandoff(env, tgUserId, handoff.conversation_id);
        await sendTelegramMessage(env, tgUserId, "🔄 Left the human chat — you're back with Fin. Ask me anything.");
        return ok();
      }
      const convId = await getConversationId(env, tgUserId);
      if (convId) await clearConversation(env, tgUserId, convId);
      await sendTelegramMessage(env, tgUserId, "🔄 Fresh start — I've cleared our conversation. Ask me anything.");
      return ok();
    }
```
(Needs `import { ... clearConversation, getConversationId } from "./kv";` — already imported.)
- [ ] **Step 3 — Route normal messages by mode.** Just before the `await forwardToFin(...)` call in the try-block, add:
```typescript
    const handoff = await getHandoff(env, tgUserId);
    if (handoff?.state === "open") {
      await replyAsUser(env, handoff.conversation_id, handoff.contact_id, text);
      return ok();
    }
```
- [ ] **Step 4 — Verify + deploy:** `npm run typecheck`; `npx wrangler deploy`.

## Task 7: Standard webhook handler (`src/intercomwebhook.ts` + route)

- [ ] **Step 1 — Create `src/intercomwebhook.ts`:**
```typescript
import type { Env } from "./env";
import { getTelegramByIntercomConversation, clearHandoff } from "./kv";
import { htmlToPlainText } from "./html";
import { sendTelegramMessage } from "./telegram";

export async function handleIntercomWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyHubSignature(env, raw, request.headers.get("X-Hub-Signature")))) {
    return new Response("invalid signature", { status: 401 });
  }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const topic: string = evt?.topic ?? "";
  const convo = evt?.data?.item;
  const intercomId = String(convo?.id ?? "");
  if (!intercomId) return ok();
  const tgUserId = await getTelegramByIntercomConversation(env, intercomId);
  if (!tgUserId) return ok();

  if (topic === "conversation.admin.replied") {
    const parts = convo?.conversation_parts?.conversation_parts ?? [];
    const last = [...parts].reverse().find(
      (p: any) => p?.part_type === "comment" && p?.author?.type === "admin", // human agent (not the Fin bot)
    );
    if (last?.body) await sendTelegramMessage(env, tgUserId, `👤 ${htmlToPlainText(String(last.body))}`);
    return ok();
  }
  if (topic === "conversation.admin.closed" || topic === "conversation.closed") {
    await clearHandoff(env, tgUserId, intercomId);
    await sendTelegramMessage(env, tgUserId, "✅ This support chat is closed. Ask me anything and Fin will help again.");
    return ok();
  }
  return ok();
}

async function verifyHubSignature(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const provided = header.replace(/^sha1=/i, "").trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.INTERCOM_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === provided;
}

function ok(): Response { return new Response("ok", { status: 200 }); }
```
- [ ] **Step 2 — Route it in `src/index.ts`:** add import `import { handleIntercomWebhook } from "./intercomwebhook";` and, with the other routes:
```typescript
    if (pathname === "/intercom/webhook" && method === "POST") {
      return handleIntercomWebhook(request, env);
    }
```
- [ ] **Step 3 — Verify + deploy:** `npm run typecheck`; `npx wrangler deploy`. Then `curl -s -o /dev/null -w "%{http_code}" -X POST https://tg-fin-bridge.askada.workers.dev/intercom/webhook -d '{}'` → expect `401`.

## Task 8: End-to-end verification (live)

- [ ] **Step 1 — Escalate:** Telegram → `/reset` → "I want to talk to a human". Expect: bot says "connected to our team", and a **new conversation appears in the Intercom inbox** (seeded with the escalation note).
- [ ] **Step 2 — Player follow-up:** send another Telegram message → it appears as the customer's message **inside that inbox conversation**.
- [ ] **Step 3 — Human reply:** reply from the Intercom inbox → it arrives in Telegram prefixed `👤`.
- [ ] **Step 4 — Close:** close/resolve the conversation in the inbox → player gets "support chat is closed" and is back with Fin (next message goes to Fin).
- [ ] **Step 5 — Lifecycle:** escalate again → a **new** inbox conversation opens (because the previous one closed). Escalate twice without closing → **same** conversation reused.
- [ ] **Step 6** — If a human reply doesn't arrive: `wrangler tail` and inspect the `/intercom/webhook` payload; confirm the latest `comment` part has `author.type === "admin"` (adjust the filter if the Fin operator uses a different type).

## Task 9: Commit + docs

- [ ] **Step 1 — Commit:**
```bash
git add -A && git commit -m "feat: human handoff - escalations open an Intercom inbox conversation, bridge agent replies to Telegram"
```
- [ ] **Step 2 — README:** add the `/intercom/webhook` route, the two new secrets, and a short "Human handoff" section describing the lifecycle.

---

## Verification summary
Escalation opens a real inbox conversation (Task 8.1); two-way bridge works (8.2–8.3); closing returns to Fin (8.4); lifecycle dedupe correct (8.5); both webhooks signature-protected.

## Risks / open questions
- **`X-Hub-Signature` is SHA1** (Intercom standard). If real deliveries fail verification, capture the header via `wrangler tail` and confirm SHA1 vs SHA256.
- **Fin operator author type** in `conversation.admin.replied`: we forward only `author.type === "admin"` (human). If the Fin bot also posts as `admin`, add an admin-id allowlist or skip the known Fin operator id (inspect in Task 8.6).
- **General token scope/plan:** creating conversations needs an active subscription + write_conversations. The Expert trial should satisfy this (confirm in Task 2).
- **Eventual consistency** on a brand-new contact is handled by the 404 retry in `createConversation`.
