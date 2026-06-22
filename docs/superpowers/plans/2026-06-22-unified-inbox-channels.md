# Unified-Inbox Channels (Telegram + Lark) Implementation Plan

> ⛔ **SUPERSEDED (2026-06-22).** Phase-0 gate failed (native Fin won't auto-answer API-created
> non-native-channel conversations). We stay on the **Fin Agent API + handoff** model and add Lark
> on it — see `2026-06-22-add-lark-channel.md`. This plan is kept for the record only.

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. This project has **no unit-test harness**; it's integration-bound, so each task is verified by **`npm run typecheck` + live curl/channel checks**. Code is complete in every step; commit per task. PATH prefix for PowerShell: `$env:Path = "C:\Program Files\nodejs;$env:Path"`; account env: `$env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"`.

**Goal:** Make Telegram and Lark behave as **customer channels into one Intercom inbox**: a message creates/continues a standard conversation, **Fin AI answers and human agents reply** in that inbox, and **every reply (Fin or human) is relayed back** to the customer's channel.

**Architecture:** Drop the Fin Agent API. Customer message → Worker → standard Intercom conversation (as the contact) → native Fin answers + agents reply → `conversation.admin.replied` webhook → Worker relays the latest non-customer part back to the channel. Channel-agnostic core keyed by `{channel, channel_user_id}`.

**Tech Stack:** Cloudflare Workers + KV (TS), Intercom Conversations REST + standard webhooks, Telegram Bot API, Lark Open Platform custom app (bot + events).

---

## Single workspace (confirm in Task 1)
One Intercom workspace (the Lark_Telegram app's; supplied token resolves to **DKM-IGAMING `ln0m55fn`**). Secrets used: `INTERCOM_API_TOKEN` (read+write Conversations & Contacts), `INTERCOM_CLIENT_SECRET` (webhook signature). `INTERCOM_BASE_URL=https://api.intercom.io`. **Fin Agent key/webhook secret are unused now.** New (Phase B): `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`.

## File structure
| File | Responsibility | Change |
|---|---|---|
| `src/kv.ts` | channel-keyed state (contact/conv/icid/lastpart/lark token) | extend |
| `src/intercom.ts` | contact + conversation bridge (`ensureContact`, `relayCustomerMessage`) | refactor channel-aware |
| `src/channels.ts` | outbound dispatch `sendToChannel` | new |
| `src/telegram.ts` | Telegram inbound → bridge; `sendTelegramMessage` | rework |
| `src/larkchannel.ts` | Lark app: token, send, inbound events | new |
| `src/intercomwebhook.ts` | relay Fin + human replies to the channel | rework |
| `src/index.ts` | routes: `/telegram/webhook`, `/intercom/webhook`, `/lark/webhook` | update |
| `src/env.ts` | add Lark vars | extend |
| `src/fin.ts`, `src/finwebhook.ts` | Fin Agent API | **delete** (dropped) |
| `src/gateway.ts` | data endpoints | remove auto-escalation (keep data) |
| `src/lark.ts`, `src/larktask.ts` | escalation cards | leave dormant (compile fine; unused) |

---

## Phase 0 — Verify the critical assumption

### Task 1: Confirm workspace + Fin auto-answers an API-created conversation
**Files:** none (live verification)

- [ ] **Step 1 — Confirm the workspace** of the general token (substitute it):
```bash
T="PASTE_GENERAL_TOKEN_FROM_CHOSEN_WORKSPACE"
curl -s https://api.intercom.io/me -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" | grep -o '"id_code":"[^"]*","name":"[^"]*"'
```
Expected: the intended workspace. (If it's not the one Fin runs in, get the token from the right one before continuing.)

- [ ] **Step 2 — Create a contact + conversation** (this is the gate):
```bash
CID=$(curl -s -X POST https://api.intercom.io/contacts -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" -H "Content-Type: application/json" -d '{"role":"user","external_id":"verify_fin_1","name":"Fin Verify"}' | grep -o '"id":"[a-f0-9]\{24\}"' | head -1 | sed 's/.*:"//;s/"//')
echo "contact=$CID"
curl -s -X POST https://api.intercom.io/conversations -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" -H "Content-Type: application/json" -d "{\"from\":{\"type\":\"user\",\"id\":\"$CID\"},\"body\":\"How do I check my deposit status?\"}" -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200` with a `conversation_id`. Note it as `CONV`.

- [ ] **Step 3 — Wait ~30–60s, then read the conversation and check for a Fin reply:**
```bash
curl -s "https://api.intercom.io/conversations/CONV?display_as=plaintext" -H "Authorization: Bearer $T" -H "Intercom-Version: 2.14" | python -c "import sys,json; d=json.load(sys.stdin); [print(p['author']['type'],'::',p.get('body','')[:80]) for p in d.get('conversation_parts',{}).get('conversation_parts',[])]"
```
Expected: at least one part with `author.type` of `admin`/`bot`/`operator` containing Fin's answer.
- [ ] **Step 4 — Record the decision:**
  - **If Fin replied** → note the **author.type** of Fin's part (the relay will forward `author.type !== "user"`). Proceed to Phase A.
  - **If Fin did NOT reply** → STOP. Fin isn't configured to answer inbound conversations in this workspace. Fix in Intercom (Settings → AI/Fin → ensure Fin answers inbound/inbox conversations) and re-test. Do not build further until this passes.

---

## Phase A — Rework Telegram onto the unified-inbox model

### Task 2: Channel-keyed KV state
**Files:** `src/kv.ts`

- [ ] **Step 1 — Append to `src/kv.ts`:**
```typescript
// --- unified-inbox channel state -------------------------------------------
export type Channel = "telegram" | "lark";

export async function getChannelContact(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`contact:${channel}:${cuid}`);
}
export async function setChannelContact(env: Env, channel: Channel, cuid: string, contactId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`contact:${channel}:${cuid}`, contactId);
}
export async function getOpenConversation(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`conv:${channel}:${cuid}`);
}
export async function setOpenConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`conv:${channel}:${cuid}`, conversationId),
    env.TG_FIN_STATE.put(`icid:${conversationId}`, JSON.stringify({ channel, cuid })),
  ]);
}
export async function getChannelByConversation(env: Env, conversationId: string): Promise<{ channel: Channel; cuid: string } | null> {
  return env.TG_FIN_STATE.get<{ channel: Channel; cuid: string }>(`icid:${conversationId}`, "json");
}
export async function clearOpenConversation(env: Env, conversationId: string): Promise<void> {
  const ref = await getChannelByConversation(env, conversationId);
  const ops: Promise<void>[] = [env.TG_FIN_STATE.delete(`icid:${conversationId}`)];
  if (ref) ops.push(env.TG_FIN_STATE.delete(`conv:${ref.channel}:${ref.cuid}`));
  await Promise.all(ops);
}
/** Dup guard: true if this part was already relayed (records it otherwise). */
export async function alreadyRelayed(env: Env, conversationId: string, partId: string): Promise<boolean> {
  const k = `lastpart:${conversationId}`;
  if ((await env.TG_FIN_STATE.get(k)) === partId) return true;
  await env.TG_FIN_STATE.put(k, partId, { expirationTtl: 7 * 24 * 60 * 60 });
  return false;
}
```
- [ ] **Step 2 — Verify:** `npm run typecheck`.

### Task 3: Channel-aware Intercom bridge
**Files:** `src/intercom.ts`

- [ ] **Step 1 — Replace `src/intercom.ts` with the unified bridge** (drops `startHandoff`; channel-aware):
```typescript
/**
 * Intercom Conversations bridge for unified-inbox channels.
 * Customer message -> ensure contact -> create or continue the customer's open
 * conversation (standard Conversations API; from.type "user" in this workspace).
 */
import type { Env } from "./env";
import { getChannelContact, setChannelContact, getOpenConversation, setOpenConversation, type Channel } from "./kv";

function headers(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.INTERCOM_API_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Intercom-Version": env.INTERCOM_API_VERSION,
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureContact(env: Env, channel: Channel, cuid: string, name: string): Promise<string> {
  const cached = await getChannelContact(env, channel, cuid);
  if (cached) return cached;
  const externalId = `${channel}_${cuid}`;
  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ role: "user", external_id: externalId, name }),
  });
  let id = res.ok ? ((await res.json()) as { id?: string }).id ?? null : await findContactByExternalId(env, externalId);
  if (!id) throw new Error(`ensureContact failed: ${res.status} ${await res.text().catch(() => "")}`);
  await setChannelContact(env, channel, cuid, id);
  return id;
}

async function findContactByExternalId(env: Env, externalId: string): Promise<string | null> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts/search`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ query: { field: "external_id", operator: "=", value: externalId } }),
  });
  if (!res.ok) return null;
  return (((await res.json()) as { data?: Array<{ id: string }> }).data?.[0]?.id) ?? null;
}

async function createConversation(env: Env, contactId: string, body: string): Promise<string> {
  let detail = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ from: { type: "user", id: contactId }, body }),
    });
    if (res.ok) {
      const data = (await res.json()) as { conversation_id?: string; id?: string };
      const id = data.conversation_id ?? data.id;
      if (id) return id;
    }
    detail = await res.text().catch(() => "");
    if (res.status === 404) { await sleep(800); continue; }
    break;
  }
  throw new Error(`createConversation failed: ${detail}`);
}

async function replyAsUser(env: Env, conversationId: string, contactId: string, body: string): Promise<void> {
  const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}/reply`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ message_type: "comment", type: "user", intercom_user_id: contactId, body }),
  });
  if (!res.ok) throw new Error(`replyAsUser failed: ${res.status} ${await res.text().catch(() => "")}`);
}

/** Bring a customer message into the inbox: continue the open conversation or open a new one. */
export async function relayCustomerMessage(env: Env, channel: Channel, cuid: string, text: string, name: string): Promise<void> {
  const contactId = await ensureContact(env, channel, cuid, name);
  const open = await getOpenConversation(env, channel, cuid);
  if (open) {
    await replyAsUser(env, open, contactId, text);
    return;
  }
  const convId = await createConversation(env, contactId, text);
  await setOpenConversation(env, channel, cuid, convId);
}
```
- [ ] **Step 2 — Verify:** `npm run typecheck` (expect errors in files that imported the removed `startHandoff` — fixed next tasks).

### Task 4: Outbound channel dispatch
**Files:** `src/channels.ts` (new)

- [ ] **Step 1 — Create `src/channels.ts`:**
```typescript
import type { Env } from "./env";
import type { Channel } from "./kv";
import { sendTelegramMessage } from "./telegram";
import { sendLarkMessage } from "./larkchannel";

export async function sendToChannel(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  if (channel === "telegram") return sendTelegramMessage(env, cuid, text);
  return sendLarkMessage(env, cuid, text);
}
```
- [ ] **Step 2** — (typecheck will fail until `larkchannel.ts` exists in Task 8; that's expected — Phase A finishes wiring Telegram, Phase B adds Lark. To keep Phase A compiling, temporarily stub `sendLarkMessage` — see Task 8 creates the real one. For now add a minimal `src/larkchannel.ts` stub:)
```typescript
import type { Env } from "./env";
export async function sendLarkMessage(_env: Env, _openId: string, _text: string): Promise<void> {
  throw new Error("Lark channel not configured yet");
}
```

### Task 5: Rework Telegram inbound + tidy webhook handler
**Files:** `src/telegram.ts`, `src/intercomwebhook.ts`

- [ ] **Step 1 — `src/telegram.ts`:** replace the imports + `forwardToFin` path so inbound goes to the bridge. Keep `verifyTelegramSecret`, `sendTelegramMessage`. New handler body:
```typescript
import type { Env } from "./env";
import { getOpenConversation, clearOpenConversation, type Channel } from "./kv";
import { relayCustomerMessage } from "./intercom";
import { buildVerifyLink } from "./identity";

const CHANNEL: Channel = "telegram";
// ... keep interfaces TelegramUpdate/TelegramMessage, TG_MAX_LEN, verifyTelegramSecret, sendTelegramMessage, sendTyping, ok ...

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!verifyTelegramSecret(request, env)) return new Response("unauthorized", { status: 401 });
  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const msg = update?.message ?? update?.edited_message;
  const text = msg?.text?.trim();
  if (!msg || !text) return ok();
  const cuid = String(msg.chat.id);
  const name = `Telegram ${cuid}`;
  try {
    if (text.startsWith("/start")) { await sendTelegramMessage(env, cuid, startMessage()); return ok(); }
    if (text.startsWith("/verify")) {
      const link = await buildVerifyLink(env, cuid);
      await sendTelegramMessage(env, cuid, `To view your account data, verify here:\n${link}`);
      return ok();
    }
    if (text.startsWith("/reset") || text.startsWith("/new")) {
      const open = await getOpenConversation(env, CHANNEL, cuid);
      if (open) await clearOpenConversation(env, open);
      await sendTelegramMessage(env, cuid, "🔄 Fresh start — ask me anything.");
      return ok();
    }
    await sendTyping(env, cuid);
    await relayCustomerMessage(env, CHANNEL, cuid, text, name);
  } catch (err) {
    console.error("telegram inbound error", err);
    await sendTelegramMessage(env, cuid, "Sorry — something went wrong. Please try again.").catch(() => {});
  }
  return ok();
}

function startMessage(): string {
  return ["👋 Welcome! Ask about KYC, deposits, withdrawals, or anything else.", "Type /verify to link your account, /reset to start over."].join("\n");
}
```
(Remove the old `forwardToFin`, the `sendToFin`/`FinUserContext` import, and the old mapping logic. `sendTelegramMessage(env, chatId, text)` stays as-is.)

- [ ] **Step 2 — `src/intercomwebhook.ts`:** rework to relay **Fin + human** replies to the channel:
```typescript
import type { Env } from "./env";
import { getChannelByConversation, clearOpenConversation, alreadyRelayed } from "./kv";
import { htmlToPlainText } from "./html";
import { sendToChannel } from "./channels";

interface Part { id?: string; part_type?: string; body?: string; author?: { type?: string } }

export async function handleIntercomWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyHubSignature(env, raw, request.headers.get("X-Hub-Signature")))) {
    return new Response("invalid signature", { status: 401 });
  }
  let evt: { topic?: string; data?: { item?: any } };
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const topic = evt.topic ?? "";
  const convo = evt.data?.item;
  const intercomId = String(convo?.id ?? "");
  if (!intercomId) return ok();
  const ref = await getChannelByConversation(env, intercomId);
  if (!ref) return ok();

  if (topic === "conversation.admin.closed" || topic === "conversation.closed") {
    await clearOpenConversation(env, intercomId);
    await sendToChannel(env, ref.channel, ref.cuid, "✅ This chat is closed. Message again anytime.").catch(() => {});
    return ok();
  }

  // Relay the newest non-customer comment (Fin OR human agent).
  const parts: Part[] = convo?.conversation_parts?.conversation_parts ?? [];
  const latest = [...parts].reverse().find((p) => p.part_type === "comment" && p.author?.type && p.author.type !== "user" && p.body);
  if (!latest?.id || !latest.body) return ok();
  if (await alreadyRelayed(env, intercomId, latest.id)) return ok();
  await sendToChannel(env, ref.channel, ref.cuid, htmlToPlainText(String(latest.body)));
  return ok();
}

async function verifyHubSignature(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const provided = header.replace(/^sha1=/i, "").trim().toLowerCase();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERCOM_CLIENT_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === provided;
}
function ok(): Response { return new Response("ok", { status: 200 }); }
```

### Task 6: Drop Fin Agent code + disable auto-escalation + deploy + test Telegram
**Files:** `src/index.ts`, `src/fin.ts` (delete), `src/finwebhook.ts` (delete), `src/gateway.ts`

- [ ] **Step 1 — Delete the Fin Agent files:** `git rm src/fin.ts src/finwebhook.ts` (the unified model doesn't use the Fin Agent API).
- [ ] **Step 2 — `src/index.ts`:** remove `import { handleFinWebhook } from "./finwebhook";` and the `/fin/webhook` route block. Keep `/telegram/webhook`, `/intercom/webhook`, `/api/*`, `/verify*`. (`/api/lark-task` may stay; it's dormant.)
- [ ] **Step 3 — `src/gateway.ts`: remove auto-escalation** (otherwise data lookups still post Lark cards). Delete the imports `buildCard, postLarkCard, type ExceptionType` (from `./lark`), `alreadyEscalatedToLark` (from `./kv`), and `brandFor` (from `./mockdata`); delete `maybeEscalate`, `detectException`, and the `CaseKind`/`InternalRecord` types; and restore the switch cases to the simple form:
```typescript
  switch (url.pathname) {
    case "/api/kyc":
      return json(kycOut(findKyc(memberId)));
    case "/api/deposit":
      return json(depositOut(findDeposit(memberId, url.searchParams.get("deposit_id")?.trim() ?? "")));
    case "/api/withdrawal":
      return json(withdrawalOut(findWithdrawal(memberId, url.searchParams.get("withdrawal_id")?.trim() ?? "")));
    default:
      return json({ error: "not_found" }, 404);
  }
```
- [ ] **Step 4 — Typecheck + deploy:** `npm run typecheck` (fix any remaining references to deleted Fin functions) then `npx wrangler deploy`.
- [ ] **Step 5 — Make sure the standard webhook is subscribed** in the workspace's Developer Hub app: endpoint `https://tg-fin-bridge.askada.workers.dev/intercom/webhook`, topics `conversation.admin.replied` **and** `conversation.admin.closed`; `INTERCOM_CLIENT_SECRET` set.
- [ ] **Step 6 — Live test (Telegram):** send the bot "how do I check my deposit?" → it appears as a conversation in the **one inbox**; **Fin's reply comes back in Telegram**; then **reply as a human agent in the inbox** → that reply also reaches Telegram; the inbox shows the **full history**. Send again → continues the same conversation (context kept). `/reset` → next message starts a new conversation.
- [ ] **Step 7 — Commit:** `git add -A && git commit -m "feat: Telegram on unified-inbox model (Fin + human replies relayed)"`.

---

## Phase B — Add Lark as a channel

### Task 7: Lark env + token cache
**Files:** `src/env.ts`, `src/kv.ts`

- [ ] **Step 1 — `src/env.ts`:** add `LARK_APP_ID: string; LARK_APP_SECRET: string; LARK_VERIFICATION_TOKEN: string;`
- [ ] **Step 2 — `src/kv.ts`:** append a tenant-token cache:
```typescript
export async function getCachedLarkToken(env: Env): Promise<string | null> {
  const v = await env.TG_FIN_STATE.get<{ token: string; exp: number }>("lark_tenant_token", "json");
  return v && v.exp > Math.floor(Date.now() / 1000) + 60 ? v.token : null;
}
export async function setCachedLarkToken(env: Env, token: string, expiresInSec: number): Promise<void> {
  await env.TG_FIN_STATE.put("lark_tenant_token", JSON.stringify({ token, exp: Math.floor(Date.now() / 1000) + expiresInSec }), { expirationTtl: expiresInSec });
}
```
- [ ] **Step 3 — Verify:** `npm run typecheck`.

### Task 8: Lark channel client (replace the stub)
**Files:** `src/larkchannel.ts`

- [ ] **Step 1 — Replace `src/larkchannel.ts`** with the real implementation (token + send + inbound events; schema-v2, no encryption):
```typescript
/**
 * Lark custom app channel: tenant token, send message, inbound event handling.
 * Event format: schema 2.0, plaintext (no Encrypt Key). Verifies the Verification Token.
 */
import type { Env } from "./env";
import { getCachedLarkToken, setCachedLarkToken } from "./kv";
import { relayCustomerMessage } from "./intercom";

const LARK_BASE = "https://open.larksuite.com/open-apis";

async function tenantToken(env: Env): Promise<string> {
  const cached = await getCachedLarkToken(env);
  if (cached) return cached;
  const res = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const data = (await res.json()) as { tenant_access_token?: string; expire?: number; code?: number; msg?: string };
  if (!data.tenant_access_token) throw new Error(`Lark token failed: ${JSON.stringify(data)}`);
  await setCachedLarkToken(env, data.tenant_access_token, data.expire ?? 7200);
  return data.tenant_access_token;
}

/** Send a plain-text message to a Lark user (open_id). */
export async function sendLarkMessage(env: Env, openId: string, text: string): Promise<void> {
  const token = await tenantToken(env);
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== 0) console.error(`Lark send failed: ${JSON.stringify(data)}`);
}

/** Lark event callback: URL verification + inbound messages. */
export async function handleLarkWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  if (!body) return new Response("bad json", { status: 400 });

  // 1) URL verification handshake
  if (body.type === "url_verification") {
    return json({ challenge: body.challenge });
  }

  // 2) Verify the Verification Token (schema v2 puts it in header.token)
  const token = body.header?.token ?? body.token;
  if (token !== env.LARK_VERIFICATION_TOKEN) return new Response("invalid token", { status: 401 });

  // 3) Inbound message
  if (body.header?.event_type === "im.message.receive_v1") {
    const msg = body.event?.message;
    const openId = body.event?.sender?.sender_id?.open_id as string | undefined;
    if (openId && msg?.message_type === "text") {
      const text = (JSON.parse(msg.content ?? "{}") as { text?: string }).text?.trim() ?? "";
      if (text) await relayCustomerMessage(env, "lark", openId, text, `Lark ${openId.slice(-6)}`);
    }
  }
  return json({ code: 0 });
}

function json(b: unknown): Response {
  return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
}
```

### Task 9: Route Lark webhook + deploy
**Files:** `src/index.ts`

- [ ] **Step 1 — `src/index.ts`:** import `handleLarkWebhook` and add:
```typescript
    if (pathname === "/lark/webhook" && method === "POST") {
      return handleLarkWebhook(request, env);
    }
```
- [ ] **Step 2 — Typecheck + deploy:** `npm run typecheck`; `npx wrangler deploy`.

### Task 10: (User) Create the Lark custom app + set secrets
**Files:** none (dashboard + secrets)

- [ ] **Step 1 (user)** — Lark Open Platform (open.larksuite.com) → **Create custom app** ("Ask Ada"). Copy **App ID** + **App Secret**.
- [ ] **Step 2 (user)** — Enable **Bot** capability. Add **permissions**: `im:message`, `im:message:send_as_bot` (send messages), `im:message.receive_v1` (receive). 
- [ ] **Step 3 (user)** — **Event Subscription:** set Request URL to `https://tg-fin-bridge.askada.workers.dev/lark/webhook`; **do not set an Encrypt Key** (plaintext); copy the **Verification Token**. Subscribe event **`im.message.receive_v1`**. (Lark will call the URL with `url_verification` — the Worker answers the challenge.)
- [ ] **Step 4 (user)** — Publish/release the app so it's active in the workspace.
- [ ] **Step 5 — Set secrets** (file method): `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`:
```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"
$json = @'
{ "LARK_APP_ID": "PASTE", "LARK_APP_SECRET": "PASTE", "LARK_VERIFICATION_TOKEN": "PASTE" }
'@
$p = Join-Path $env:TEMP "k.json"; [System.IO.File]::WriteAllText($p,$json)
npx wrangler secret bulk $p; Remove-Item $p -Force
```

### Task 11: Live test (Lark) + commit
**Files:** none

- [ ] **Step 1** — In Lark, **DM the "Ask Ada" app**: "how do I check my deposit?" → it should create a conversation in the **same Intercom inbox**, Fin replies **back in Lark**, and a human inbox reply also reaches Lark. Full history in the inbox.
- [ ] **Step 2** — Confirm Telegram still works the same → **both channels, one inbox.**
- [ ] **Step 3** — `wrangler tail` if a step fails: token errors (check app secret), no inbound (check event subscription URL verified + permissions + app published), no relay (check the standard webhook topics + that Fin's part `author.type !== "user"`).
- [ ] **Step 4 — Commit:** `git add -A && git commit -m "feat: Lark customer channel on unified-inbox model"`.

### Task 12: README + docs
- [ ] Update `README.md`: the unified-inbox model, `/lark/webhook` route, Lark app secrets, and that the Fin Agent + escalation-card paths are superseded/dormant. Commit.

---

## Verification summary
Phase 0 proves Fin auto-answers (gate). Phase A: Telegram message → one inbox → Fin + human replies relayed back, full history, context kept. Phase B: Lark DM behaves identically, same inbox. Both webhooks signature-checked; no echo loops (customer parts never relayed; dup guard on part id).

## Risks / open questions
- **Fin reply author type / webhook:** if Fin's reply doesn't fire `conversation.admin.replied` (e.g. Fin posts as a `bot` that doesn't trigger it), Phase 0 Step 3 reveals it; then also subscribe `conversation.admin.single.created` or the Fin-specific topic and relay from there. The relay already forwards any `author.type !== "user"`.
- **Lark region:** uses `open.larksuite.com` (international). If on Feishu (China), base is `open.feishu.cn`.
- **Lark event encryption:** plan assumes no Encrypt Key (plaintext). If one is required, add AES-256-CBC decryption of `body.encrypt` before parsing.
- **Conversation lifetime:** one open conversation per channel-user until closed in the inbox (or `/reset`). If you prefer per-session, close conversations on a timer.
- **member_id for data connectors:** Fin still collects it in-chat (as today); wiring `/verify` to set it as a contact attribute is a follow-on.
