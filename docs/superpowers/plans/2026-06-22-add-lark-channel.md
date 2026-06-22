# Add Lark Channel (Fin Agent API model) — Implementation Plan

> **For agentic workers:** Steps use `- [ ]`. No unit-test harness — verify via `npm run typecheck` + live channel tests. PowerShell PATH: `$env:Path = "C:\Program Files\nodejs;$env:Path"`; account: `$env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"`.

**Goal:** Add **Lark** as a second customer channel on the **existing Fin Agent API + handoff** model (the one Telegram already uses). Lark users chat with Fin; Fin's replies go back to Lark; escalations bridge to a human in the Intercom inbox whose replies return to Lark — exactly like Telegram.

**Architecture:** Keep everything we built. Generalize the Telegram-specific flow to be **channel-keyed** (`{channel, channel_user_id}`) with a `sendToChannel` dispatcher, then add a **Lark custom-app adapter** (the "real account": tenant token, send message, inbound events). Conversation routing uses KV mapping `fin:{conversation_id} → {channel, cuid}`.

**Tech Stack:** Cloudflare Workers + KV (TS), Intercom Fin Agent API + standard handoff webhook, Telegram Bot API, Lark Open Platform custom app (bot + `im.message.receive_v1` events).

---

## File changes
| File | Change |
|---|---|
| `src/channels.ts` | **new** — `Channel` type + `sendToChannel(env, channel, cuid, text)` |
| `src/kv.ts` | channel-key the Fin-conversation + handoff + contact maps |
| `src/fin.ts` | `newConversationId(channel, cuid)`; carry channel |
| `src/finwebhook.ts` | route `fin_replied` via `{channel, cuid}` → `sendToChannel`; escalation via channel |
| `src/telegram.ts` | inbound passes `channel:"telegram"`; outbound `sendTelegramMessage` unchanged |
| `src/intercom.ts` | `startHandoff(channel, cuid, …)`; channel-aware contact/handoff |
| `src/intercomwebhook.ts` | relay human replies via `{channel, cuid}` → `sendToChannel` |
| `src/larkchannel.ts` | **new** — Lark app: tenant token, `sendLarkMessage`, `handleLarkWebhook` |
| `src/index.ts` | add `POST /lark/webhook` |
| `src/env.ts` | add `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN` |

---

## Task 0: Re-verify Telegram still works post-migration
**Files:** none

- [ ] Send the Telegram bot "how do I check my deposit?" → Fin replies (confirms the migrated Fin key `tok:e73b2d9d` + webhook secret are working). If not, fix the Fin key/secret consistency before continuing. `npx wrangler tail` to watch.

## Task 1: Channel-keyed KV + dispatcher
**Files:** `src/kv.ts`, `src/channels.ts`

- [ ] **Step 1 — `src/kv.ts`:** add channel-keyed helpers (replace the tg-specific conversation + handoff + contact helpers; keep `Channel` exported once):
```typescript
export type Channel = "telegram" | "lark";
export interface UserRef { channel: Channel; cuid: string }

// Fin conversation per channel-user
export async function getFinConversation(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`conv:${channel}:${cuid}`);
}
export async function linkFinConversation(env: Env, channel: Channel, cuid: string, convId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`conv:${channel}:${cuid}`, convId),
    env.TG_FIN_STATE.put(`fin:${convId}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}
export async function getUserByFinConversation(env: Env, convId: string): Promise<UserRef | null> {
  return env.TG_FIN_STATE.get<UserRef>(`fin:${convId}`, "json");
}
export async function clearFinConversation(env: Env, channel: Channel, cuid: string, convId: string): Promise<void> {
  await Promise.all([env.TG_FIN_STATE.delete(`conv:${channel}:${cuid}`), env.TG_FIN_STATE.delete(`fin:${convId}`)]);
}

// Handoff per channel-user
export interface Handoff { conversation_id: string; contact_id: string; state: "open" }
export async function getHandoff(env: Env, channel: Channel, cuid: string): Promise<Handoff | null> {
  return env.TG_FIN_STATE.get<Handoff>(`handoff:${channel}:${cuid}`, "json");
}
export async function setHandoff(env: Env, channel: Channel, cuid: string, h: Handoff): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`handoff:${channel}:${cuid}`, JSON.stringify(h)),
    env.TG_FIN_STATE.put(`icid:${h.conversation_id}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}
export async function getUserByIntercomConversation(env: Env, convId: string): Promise<UserRef | null> {
  return env.TG_FIN_STATE.get<UserRef>(`icid:${convId}`, "json");
}
export async function clearHandoff(env: Env, channel: Channel, cuid: string, convId: string): Promise<void> {
  await Promise.all([env.TG_FIN_STATE.delete(`handoff:${channel}:${cuid}`), env.TG_FIN_STATE.delete(`icid:${convId}`)]);
}
export async function getContactId(env: Env, channel: Channel, cuid: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`contact:${channel}:${cuid}`);
}
export async function setContactId(env: Env, channel: Channel, cuid: string, id: string): Promise<void> {
  await env.TG_FIN_STATE.put(`contact:${channel}:${cuid}`, id);
}
```
(Remove the old single-arg `getConversationId/linkConversation/getTelegramByConversation/clearConversation/getHandoff/clearHandoff/getContactId/setContactId/getTelegramByIntercomConversation`; the channel-aware versions replace them. Keep `getMapping/putMapping`, verify-state, and the dormant `alreadyEscalatedToLark`.)

- [ ] **Step 2 — `src/channels.ts` (new):**
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
- [ ] **Step 3 — temporary stub `src/larkchannel.ts`** (real version in Task 4) so it compiles:
```typescript
import type { Env } from "./env";
export async function sendLarkMessage(_e: Env, _c: string, _t: string): Promise<void> { throw new Error("Lark not configured yet"); }
```
- [ ] **Step 4 — Verify:** `npm run typecheck` (errors in fin/telegram/intercom expected; fixed next).

## Task 2: Channel-aware Fin flow
**Files:** `src/fin.ts`, `src/telegram.ts`, `src/finwebhook.ts`

- [ ] **Step 1 — `src/fin.ts`:** make the conversation id channel-prefixed and carry channel on the context.
  - Add `channel: Channel` to `FinUserContext` (import `Channel` from `./kv`).
  - Change `newConversationId(userId)` → `newConversationId(ctx: FinUserContext)` returning `` `${ctx.channel}-${ctx.userId}-${Date.now()}` ``.
- [ ] **Step 2 — `src/telegram.ts`:** in `forwardToFin`, set `channel: "telegram"` on the `FinUserContext`, and replace the KV calls with the channel-aware ones: `getFinConversation(env,"telegram",cuid)` / `linkFinConversation(env,"telegram",cuid,newId)`. `/reset` uses `getHandoff/clearHandoff/clearFinConversation` with `"telegram"`. Inbound handoff check uses `getHandoff(env,"telegram",cuid)` then `replyAsUser`.
- [ ] **Step 3 — `src/finwebhook.ts`:** import `getUserByFinConversation`, `clearFinConversation` from `./kv`, `sendToChannel` from `./channels`, `startHandoff` from `./intercom`.
```typescript
  if (event.type === "fin_replied") {
    const ref = await getUserByFinConversation(env, event.conversationId);
    if (!ref) return ok();
    const text = htmlToPlainText(event.replyHtml) || "(Fin sent an empty reply)";
    await sendToChannel(env, ref.channel, ref.cuid, text);
    return ok();
  }
  if (event.type === "fin_status_updated") {
    const ref = await getUserByFinConversation(env, event.conversationId);
    if (ref && event.status === "escalated") await startHandoff(env, ref.channel, ref.cuid, "(escalation requested)");
    if (ref && ["escalated", "resolved", "complete"].includes(event.status ?? "")) {
      await clearFinConversation(env, ref.channel, ref.cuid, event.conversationId);
    }
    return ok();
  }
```
- [ ] **Step 4 — Verify:** `npm run typecheck` (intercom errors next).

## Task 3: Channel-aware handoff
**Files:** `src/intercom.ts`, `src/intercomwebhook.ts`

- [ ] **Step 1 — `src/intercom.ts`:** make `ensureContact` and `startHandoff` channel-aware.
  - `ensureContact(env, channel: Channel, cuid: string)`: external_id `${channel}_${cuid}`; name `${channel} ${cuid}`; cache via `getContactId/setContactId(env, channel, cuid)`.
  - `startHandoff(env, channel: Channel, cuid: string, lastQuestion: string)`: reuse-or-create as today, but `setHandoff(env, channel, cuid, …)` and notify via `sendToChannel(env, channel, cuid, …)` (import from `./channels`). Seed body: `Escalated from ${channel}. …`.
  - Keep `replyAsUser` as-is.
- [ ] **Step 2 — `src/intercomwebhook.ts`:** relay human replies to the right channel.
```typescript
import { getUserByIntercomConversation, clearHandoff } from "./kv";
import { sendToChannel } from "./channels";
// conversation.admin.replied:
const ref = await getUserByIntercomConversation(env, intercomId);
if (!ref) return ok();
const last = [...parts].reverse().find((p) => p.part_type === "comment" && p.author?.type === "admin");
if (last?.body) await sendToChannel(env, ref.channel, ref.cuid, `👤 ${htmlToPlainText(String(last.body))}`);
// conversation.admin.closed:
if (ref) { await clearHandoff(env, ref.channel, ref.cuid, intercomId); await sendToChannel(env, ref.channel, ref.cuid, "✅ This support chat is closed. Ask me anything and Fin will help again."); }
```
- [ ] **Step 3 — Verify + deploy:** `npm run typecheck`; `npx wrangler deploy`. Re-test **Telegram** end-to-end (Fin chat + escalate → human reply) to confirm the channel-aware refactor didn't break it.

## Task 4: Lark adapter
**Files:** `src/larkchannel.ts` (replace stub), `src/env.ts`, `src/index.ts`

- [ ] **Step 1 — `src/env.ts`:** add `LARK_APP_ID: string; LARK_APP_SECRET: string; LARK_VERIFICATION_TOKEN: string;`
- [ ] **Step 2 — `src/larkchannel.ts`:** full implementation:
```typescript
/** Lark custom-app channel: tenant token, send text, inbound events (schema v2, plaintext). */
import type { Env } from "./env";
import { getCachedLarkToken, setCachedLarkToken } from "./kv";
import { forwardToFin } from "./telegram"; // reuse the Fin-forward (channel-aware) — see note

const LARK_BASE = "https://open.larksuite.com/open-apis";

async function tenantToken(env: Env): Promise<string> {
  const cached = await getCachedLarkToken(env);
  if (cached) return cached;
  const res = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const d = (await res.json()) as { tenant_access_token?: string; expire?: number };
  if (!d.tenant_access_token) throw new Error(`Lark token failed: ${JSON.stringify(d)}`);
  await setCachedLarkToken(env, d.tenant_access_token, d.expire ?? 7200);
  return d.tenant_access_token;
}

export async function sendLarkMessage(env: Env, openId: string, text: string): Promise<void> {
  const token = await tenantToken(env);
  const res = await fetch(`${LARK_BASE}/im/v1/messages?receive_id_type=open_id`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const d = (await res.json()) as { code?: number };
  if (d.code !== 0) console.error(`Lark send failed: ${JSON.stringify(d)}`);
}

export async function handleLarkWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  if (!body) return new Response("bad json", { status: 400 });
  if (body.type === "url_verification") return json({ challenge: body.challenge });
  const token = body.header?.token ?? body.token;
  if (token !== env.LARK_VERIFICATION_TOKEN) return new Response("invalid token", { status: 401 });
  if (body.header?.event_type === "im.message.receive_v1") {
    const openId = body.event?.sender?.sender_id?.open_id as string | undefined;
    const msg = body.event?.message;
    if (openId && msg?.message_type === "text") {
      const text = (JSON.parse(msg.content ?? "{}") as { text?: string }).text?.trim() ?? "";
      if (text) await routeLarkInbound(env, openId, text);
    }
  }
  return json({ code: 0 });
}

function json(b: unknown): Response { return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }); }
```
- [ ] **Step 3 — channel-agnostic inbound:** the Fin-forward logic lives in `telegram.ts` as `forwardToFin`. **Extract it** into a shared `routeInbound(env, channel, cuid, text)` (move from telegram.ts into a small `inbound.ts`, or export a channel-aware `forwardToFin(env, channel, cuid, text)`), then both telegram.ts and larkchannel.ts call it. Implement `routeLarkInbound(env, openId, text)` = handoff-aware: if `getHandoff(env,"lark",openId)` open → `replyAsUser`; else `forwardToFin(env,"lark",openId,text)`. (Mirror telegram.ts's inbound branch.)
- [ ] **Step 4 — `src/kv.ts`:** add the Lark token cache:
```typescript
export async function getCachedLarkToken(env: Env): Promise<string | null> {
  const v = await env.TG_FIN_STATE.get<{ token: string; exp: number }>("lark_tenant_token", "json");
  return v && v.exp > Math.floor(Date.now() / 1000) + 60 ? v.token : null;
}
export async function setCachedLarkToken(env: Env, token: string, sec: number): Promise<void> {
  await env.TG_FIN_STATE.put("lark_tenant_token", JSON.stringify({ token, exp: Math.floor(Date.now() / 1000) + sec }), { expirationTtl: sec });
}
```
- [ ] **Step 5 — `src/index.ts`:** add `if (pathname === "/lark/webhook" && method === "POST") return handleLarkWebhook(request, env);`
- [ ] **Step 6 — Verify + deploy:** `npm run typecheck`; `npx wrangler deploy`.

## Task 5: (User) Create the Lark custom app + set secrets
- [ ] **Step 1** — open.larksuite.com → **Create custom app** ("Ask Ada"). Copy **App ID** + **App Secret**.
- [ ] **Step 2** — Enable **Bot**. Add scopes: `im:message`, `im:message:send_as_bot`, and the receive-message event scope.
- [ ] **Step 3** — **Event Subscription:** Request URL `https://tg-fin-bridge.askada.workers.dev/lark/webhook`; **no Encrypt Key** (plaintext); copy the **Verification Token**; subscribe **`im.message.receive_v1`**.
- [ ] **Step 4** — Publish/release the app.
- [ ] **Step 5 — Set secrets** (file method): `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`.

## Task 6: End-to-end test + commit
- [ ] **Step 1** — DM the Lark "Ask Ada" app: "how do I check my deposit?" → Fin replies in Lark.
- [ ] **Step 2** — In Lark say "I want a human" → escalation → a conversation appears in the Intercom inbox → reply as agent → reaches Lark (👤). Close → back to Fin.
- [ ] **Step 3** — Confirm Telegram still works identically (both channels, same model).
- [ ] **Step 4 — Commit:** `git add -A && git commit -m "feat: Lark as a second channel on the Fin Agent + handoff model"`.
- [ ] **Step 5 — README** update (Lark channel, /lark/webhook, Lark secrets).

---

## Verification summary
Telegram unchanged in behavior (Task 0 + Task 3 Step 3); Lark gains Fin chat + human handoff via the same model; conversation routing is channel-keyed; replies go to the correct channel.

## Risks
- **Lark region:** `open.larksuite.com` (international). Feishu/China = `open.feishu.cn`.
- **Lark event encryption:** assumes no Encrypt Key. If required, add AES-256-CBC decrypt of `body.encrypt`.
- **Handoff workspace consistency:** the general token + client secret (handoff) must be from the same workspace as the Fin Agent conversations; reconcile if human replies don't relay (separate from Lark chat).
- **`forwardToFin` extraction:** moving it to a shared function must keep Telegram's behavior identical (Task 3 Step 3 re-test guards this).
