# Telegram ↔ Intercom Fin Bridge — Completion Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Execute top-to-bottom; each task ends in a verifiable state.

**Goal:** Finish the Telegram ↔ Intercom Fin demo so a player can chat with Fin on Telegram, get live (mock) iGaming answers, and have escalations surface in the Intercom inbox where a human can reply back to the player.

**Architecture:** Cloudflare Worker bridges Telegram and the **Intercom Fin Agent API** (new workspace that has it fully enabled). Fin's own answers return via the **Fin Agent webhook** (`fin_replied`). When Fin **escalates**, the conversation appears in the **Intercom inbox**; the human agent's replies return to Telegram via the **standard Intercom webhook** (`conversation.admin.replied`). Mock iGaming data is served by gateway endpoints the Fin Data Connectors call.

**Tech Stack:** Cloudflare Workers + KV (TypeScript, Wrangler v3), Telegram Bot API, Intercom Fin Agent API (v2.14) + standard Conversations webhooks.

---

## Current state (verified working)

- ✅ Bot **@FinAiHelper12037_Bot**; Telegram inbound+outbound through the Worker (after the secret fix). `/start` and `/verify` reply correctly.
- ✅ Worker deployed: `https://tg-fin-bridge.askada.workers.dev` (Cloudflare account `5f4d31a75fd669df8527210deb973591`).
- ✅ KV bound (`TG_FIN_STATE`); secrets set cleanly via `wrangler secret bulk` (no CRLF corruption).
- ✅ Fin Agent API request/response/webhook shapes **verified** against the 2.14 spec + a live `200` (`/fin/start` returns `conversation_id`, `intercom_conversation_id`, `status`).
- ✅ TypeScript compiles clean (`npm run typecheck`).
- ⚠️ **Old workspace** could not expose the Fin Agent webhook config → switching to the **new workspace** (key `tok:d72cd83c…`, recorded in chat, NOT in this file).
- ❌ Remaining: point at new workspace, configure the Fin webhook, get Fin's replies flowing to Telegram, add human-handoff return path, wire data connectors/procedures, remove diagnostic code.

## Key references (executor needs these)

- Node is installed but **not on PATH**; prefix every PowerShell command with: `$env:Path = "C:\Program Files\nodejs;$env:Path"`
- Cloudflare account env for wrangler: `$env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"`
- Worker base URL: `https://tg-fin-bridge.askada.workers.dev`
- Secret values live in the chat session / Worker secrets — **never write them into committed files.**
- Intercom API version header: `2.14` (verified). Region base URL is `https://api.intercom.io` (US) — **confirm for the new workspace in Task 1.**

## Files

| File | Responsibility | Change in this plan |
|---|---|---|
| `src/fin.ts` | Fin Agent API client + webhook parse/verify | Capture & return `intercom_conversation_id` |
| `src/finwebhook.ts` | Handle `fin_replied` / `fin_status_updated` → Telegram | Remove diagnostic leniency; store intercom-id map |
| `src/intercomwebhook.ts` | **NEW** — standard `conversation.admin.replied` (human replies) → Telegram | Create |
| `src/kv.ts` | KV helpers | Add `icid:` (intercom conv → tg) map |
| `src/index.ts` | Router | Add `POST /intercom/webhook` route |
| `src/telegram.ts`, `src/identity.ts`, `src/gateway.ts`, `src/mockdata.ts` | already built | unchanged (verify only) |

---

## Task 1: Point the bridge at the new Fin workspace

**Files:** none (config/secrets only)

- [ ] **Step 1 — Confirm the new workspace region.** Ask the user which region the new workspace is in (US/EU/AU), or check the workspace URL (`app.intercom.com`=US, `app.eu.intercom.com`=EU, `app.au.intercom.com`=AU). If not US, update `INTERCOM_BASE_URL` in `wrangler.toml` to `https://api.eu.intercom.io` or `https://api.au.intercom.io`.

- [ ] **Step 2 — Validate the new key + region with a non-destructive-as-possible probe.** This starts one Fin conversation (acceptable validation). Run in Git Bash:

```bash
NEW="<NEW_WORKSPACE_FIN_API_KEY>"
curl -s -w "\nHTTP %{http_code}\n" -X POST https://api.intercom.io/fin/start \
  -H "Authorization: Bearer $NEW" -H "Intercom-Version: 2.14" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"conversation_id":"probe-newws-1","message":{"author":"user","body":"setup check"},"user":{"id":"probe-user-1"}}'
```

Expected: `HTTP 200` with `conversation_id`, `intercom_conversation_id`, `status:"thinking"`. If `401`/`404`, the region base URL is wrong — adjust and retry.

- [ ] **Step 3 — Update the Worker secret to the new key** (use the file method to avoid CRLF). In PowerShell:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
$env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"
$json = @'
{ "INTERCOM_FIN_API_KEY": "<NEW_WORKSPACE_FIN_API_KEY>" }
'@
$p = Join-Path $env:TEMP "k.json"; [System.IO.File]::WriteAllText($p,$json)
npx wrangler secret bulk $p; Remove-Item $p -Force
```

Expected: `1 secret successfully uploaded`.

- [ ] **Step 4 — Commit any wrangler.toml region change.**

```bash
git add wrangler.toml && git commit -m "chore: point bridge at new Fin workspace" || echo "no toml change"
```

---

## Task 2: Configure the Fin Agent webhook + tighten the handler

**Files:** `src/finwebhook.ts`

- [ ] **Step 1 — (User, dashboard) Set the Fin Agent API callback URL** in the NEW workspace's Fin Agent API settings. Callback URL:

```
https://tg-fin-bridge.askada.workers.dev/fin/webhook
```

Save, then **reveal & copy the generated signing secret**.

- [ ] **Step 2 — Set the signing secret** as a Worker secret (file method):

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"
$json = @'
{ "INTERCOM_FIN_WEBHOOK_SECRET": "PASTE_THE_SIGNING_SECRET_HERE" }
'@
$p = Join-Path $env:TEMP "k.json"; [System.IO.File]::WriteAllText($p,$json)
npx wrangler secret bulk $p; Remove-Item $p -Force
```

- [ ] **Step 3 — Remove the diagnostic leniency in `src/finwebhook.ts`.** Replace the diagnostic block + the `if (!finSig) return ok();` shortcut so unsigned requests are rejected again:

```typescript
export async function handleFinWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const signature = request.headers.get("X-Fin-Agent-API-Webhook-Signature");
  if (!(await verifyFinWebhookSignature(env, raw, signature))) {
    return new Response("invalid signature", { status: 401 });
  }
  // ...existing JSON.parse + parseFinWebhook + fin_replied / fin_status_updated handling unchanged...
}
```

- [ ] **Step 4 — Typecheck, deploy, commit.**

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"
npm run typecheck; npx wrangler deploy
```
```bash
git add src/finwebhook.ts && git commit -m "fix: enforce Fin webhook signature (remove diagnostic)"
```

- [ ] **Step 5 — Verify signature rejection.** `curl -s -o /dev/null -w "%{http_code}" -X POST https://tg-fin-bridge.askada.workers.dev/fin/webhook -d '{}'` → expect `401`.

---

## Task 3: Verify the core loop (Telegram → Fin → Telegram)

**Files:** none (live test)

- [ ] **Step 1 — Start log capture** (background): `npx wrangler tail tg-fin-bridge --format json` to a file.
- [ ] **Step 2 — (User) Send a message** to @FinAiHelper12037_Bot: `hello`.
- [ ] **Step 3 — Confirm in logs:** `/telegram/webhook` → `200`; a follow-up `/fin/webhook` hit with `X-Fin-Agent-API-Webhook-Signature` and `event_name:"fin_replied"`.
- [ ] **Step 4 — Confirm in Telegram:** Fin's answer appears in the chat.
- [ ] **Step 5** — If the reply does not arrive: check `wrangler tail` for a `401` on `/fin/webhook` (signing-secret mismatch → re-copy in Task 2) or `htmlToPlainText` empty (inspect logged `body`).

---

## Task 4: Human handoff — escalation in inbox + human replies back to Telegram

**Files:** `src/fin.ts`, `src/kv.ts`, `src/intercomwebhook.ts` (new), `src/index.ts`, `src/env.ts`

- [ ] **Step 1 — Capture `intercom_conversation_id`.** In `src/fin.ts`, parse it from the start/reply response and return it:

```typescript
// in sendToFin, after res.ok check:
const data = (await res.json().catch(() => ({}))) as { intercom_conversation_id?: string };
return { conversationId: id, intercomConversationId: data.intercom_conversation_id };
```
Update the return type to `{ conversationId: string; intercomConversationId?: string }`.

- [ ] **Step 2 — Store the intercom-id → telegram map.** In `src/kv.ts` add:

```typescript
export async function linkIntercomConversation(env: Env, intercomId: string, tgUserId: string): Promise<void> {
  await env.TG_FIN_STATE.put(`icid:${intercomId}`, tgUserId);
}
export async function getTelegramByIntercomConversation(env: Env, intercomId: string): Promise<string | null> {
  return env.TG_FIN_STATE.get(`icid:${intercomId}`);
}
```
In `src/telegram.ts` `forwardToFin`, after `sendToFin`, call `linkIntercomConversation` when `intercomConversationId` is present.

- [ ] **Step 3 — Add `INTERCOM_CLIENT_SECRET` to `src/env.ts`** (the new workspace Developer Hub app's client secret, used to verify `X-Hub-Signature`).

- [ ] **Step 4 — Create `src/intercomwebhook.ts`** to handle standard webhooks. Verify `X-Hub-Signature` (HMAC-**SHA1** of raw body with the app client secret), and forward only **human admin** replies (skip Fin/bot, which already arrive via `fin_replied`):

```typescript
import type { Env } from "./env";
import { getTelegramByIntercomConversation } from "./kv";
import { htmlToPlainText } from "./html";
import { sendTelegramMessage } from "./telegram";

export async function handleIntercomWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyHubSignature(env, raw, request.headers.get("X-Hub-Signature")))) {
    return new Response("invalid signature", { status: 401 });
  }
  const evt = JSON.parse(raw) as any;
  if (evt?.topic !== "conversation.admin.replied") return new Response("ok", { status: 200 });

  const convo = evt?.data?.item;
  const intercomId = String(convo?.id ?? "");
  const parts = convo?.conversation_parts?.conversation_parts ?? [];
  const last = parts[parts.length - 1];
  // Only forward HUMAN agent replies; Fin's own replies come via fin_replied.
  if (!last || last.part_type !== "comment" || last?.author?.type !== "admin") {
    return new Response("ok", { status: 200 });
  }
  const tgUserId = await getTelegramByIntercomConversation(env, intercomId);
  if (tgUserId) {
    const text = htmlToPlainText(String(last.body ?? "")) || "(empty reply)";
    await sendTelegramMessage(env, tgUserId, `👤 ${text}`);
  }
  return new Response("ok", { status: 200 });
}

async function verifyHubSignature(env: Env, raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const provided = header.replace(/^sha1=/i, "").trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.INTERCOM_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === provided;
}
```

- [ ] **Step 5 — Route it.** In `src/index.ts` add: `if (pathname === "/intercom/webhook" && method === "POST") return handleIntercomWebhook(request, env);`

- [ ] **Step 6 — Set the client secret + deploy.** Bulk-set `INTERCOM_CLIENT_SECRET` (file method), `npm run typecheck`, `npx wrangler deploy`, commit.

- [ ] **Step 7 — (User, dashboard) In the NEW workspace Developer Hub app:** set Webhooks Endpoint URL to `https://tg-fin-bridge.askada.workers.dev/intercom/webhook`, grant read-conversations permission (Configure → Authentication), subscribe topic **`conversation.admin.replied`**, copy the app **Client secret** (Basic information) for Step 6.

- [ ] **Step 8 — Verify handoff.** Send a Telegram message that triggers escalation (e.g., "I want to talk to a human"). Confirm: (a) `fin_status_updated` `escalated` arrives, bot tells the user it's escalated; (b) the conversation **appears in the Intercom inbox**; (c) reply as a human agent in the inbox → the reply reaches Telegram prefixed with 👤. If (c) fails, inspect `wrangler tail` for the `/intercom/webhook` payload and adjust the part-extraction in Step 4.

---

## Task 5: Verify identity flow (M2)

**Files:** none (verify built code)

- [ ] **Step 1** — Send `/verify` to the bot → tap the link → mock login page lists demo members (`300425`, `300999`).
- [ ] **Step 2** — Pick a member, submit → page shows "verified", bot sends the verified confirmation.
- [ ] **Step 3** — Confirm KV mapping: `npx wrangler kv key get "tg:<your_telegram_id>" --binding TG_FIN_STATE` shows `verified:true` + `member_id`. (Find your id in `wrangler tail`.)

---

## Task 6: iGaming data (M3) — attributes, connectors, procedures

**Files:** none (Intercom dashboard + gateway already built)

- [ ] **Step 1 — Test the gateway directly** (proves masking + safe-reason mapping):

```bash
curl.exe -H "Authorization: Bearer <GATEWAY_API_TOKEN>" "https://tg-fin-bridge.askada.workers.dev/api/deposit?member_id=300425&deposit_id=DEP-260603-001"
```
Expected JSON: `payment_status:"SETTLED"`, `posting_status:"PENDING"`, no internal codes. Repeat for `/api/kyc?member_id=300425` and `/api/withdrawal?member_id=300425&withdrawal_id=WD-260612-006` (expect `masked_account:"****8821"`).

- [ ] **Step 2 — (User, dashboard) Create custom data attributes** in the new workspace (Settings → Data): `verified`, `member_id`, `brand_id`, `language`, `channel`.
- [ ] **Step 3 — (User, dashboard) Create 3 Data Connectors** (Actions), each with header `Authorization: Bearer <GATEWAY_API_TOKEN>`:
  - `dc_get_kyc_case` → `GET .../api/kyc?member_id={member_id}`
  - `dc_get_deposit_status` → `GET .../api/deposit?member_id={member_id}&deposit_id={deposit_id}`
  - `dc_get_withdrawal_status` → `GET .../api/withdrawal?member_id={member_id}&withdrawal_id={withdrawal_id}`
- [ ] **Step 4 — (User, dashboard) Create 3 Procedures** (`proc_kyc_overall_status`, `proc_deposit_status`, `proc_withdrawal_status`) that require `verified == true`, call the matching connector, branch on status, and reply using `user_safe_reason`/`failure_reason` (never raw codes).
- [ ] **Step 5 — Verify via Telegram:** as a verified user, ask "status of deposit DEP-260603-001?" → Fin returns payment/posting/ETA, account masked. As an unverified user, the same question prompts `/verify`.

---

## Task 7: Cleanup & polish

**Files:** `src/finwebhook.ts`, `README.md`

- [ ] **Step 1** — Confirm no diagnostic `console.log("FIN_WEBHOOK_HIT"...)` remains (removed in Task 2). Grep: `rg "FIN_WEBHOOK_HIT" src` → no matches.
- [ ] **Step 2** — Multilingual check: send a 中文 question; Fin should answer in Chinese (it uses the `language` attribute).
- [ ] **Step 3** — Update `README.md`: new-workspace note, `/intercom/webhook` route, `INTERCOM_CLIENT_SECRET` secret, human-handoff behavior.
- [ ] **Step 4** — Commit: `git add -A && git commit -m "docs: update README for new workspace + human handoff"`.

## Task 8: Final end-to-end demo (source doc §12)

- [ ] Run the demo script end-to-end: KYC question → normal deposit question → delayed/escalation case → human picks up in inbox → resolution returns to Telegram. Confirm safe wording + masking throughout, in EN and 中文.

---

## Verification (overall)
- Fin answers in Telegram (Task 3); escalation appears in inbox and human replies return (Task 4); identity gating works (Task 5); live (mock) data with masking + safe wording (Task 6); signatures enforced on both webhooks; no diagnostic code remains.

## Risks / open questions
- **Does `conversation.admin.replied` fire for escalated Fin Agent conversations, and does `data.item.id` equal `intercom_conversation_id`?** Task 4 Step 8 verifies; if the id differs, map via the value present in the escalation/standard payload instead.
- **`X-Hub-Signature` algorithm** is assumed SHA1 (Intercom standard). If verification fails on real deliveries, capture the header in `wrangler tail` and confirm SHA1 vs SHA256.
- **New workspace region** must be confirmed (Task 1) — base URL depends on it.
- **Custom attributes** unknown to Intercom are non-fatal but ignored; Procedures only gate correctly once Task 6 Step 2 creates them.
