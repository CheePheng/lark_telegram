# Telegram ↔ Intercom Fin bridge (iGaming Phase 1)

A Cloudflare Worker that lets players chat with **Intercom Fin** over **Telegram**, with
identity verification and live (mock) iGaming data lookups (KYC / deposit / withdrawal).

This is **Phase 1**: *demo now, prod-ready later*. iGaming data is **mocked**; the identity
token/signature mechanics are real. **Lark is not included** in this phase.

```
Player (Telegram)
   │  message
   ▼
Telegram Bot API ─► Cloudflare Worker  /telegram/webhook
                         │ verified? if not → send a verify link
                         │ call Intercom Fin  /fin/start | /fin/reply
                         ▼
                    Intercom Fin (AI brain)
                         │ needs data → GET /api/kyc | /api/deposit | /api/withdrawal
                         │              (Worker returns masked, safe JSON from MOCK data)
                         │ answer ready → POST /fin/webhook  (signed)
                         ▼
                    Cloudflare Worker ─► Telegram sendMessage ─► Player
```

---

## What YOU provide (credentials checklist)

| # | Value | Where to get it | Becomes secret |
|---|---|---|---|
| 1 | Telegram bot token | @BotFather (Step A) | `TELEGRAM_BOT_TOKEN` |
| 2 | Fin Agent API key | Intercom → Fin AI Agent → Deploy → Fin Agent API (Step C1) | `INTERCOM_FIN_API_KEY` |
| 3 | Fin webhook signing secret | Intercom Fin webhook setup (Step C2) | `INTERCOM_FIN_WEBHOOK_SECRET` |
| 4 | Intercom region | Your Intercom plan/region (US/EU/AU) | `INTERCOM_BASE_URL` (var) |

The following secrets you **generate yourself** (any long random string — see "Generate secrets" below):
`TELEGRAM_WEBHOOK_SECRET`, `GATEWAY_API_TOKEN`, `IDENTITY_SIGNING_SECRET`.

> ℹ️ The **Fin Agent API is invite-only ("managed availability")**. If you don't see it in the
> Intercom dashboard, ask your Intercom account manager to enable it for your workspace.
> The Fin Agent API key is **narrowly scoped**: it works on `/fin/*` but returns `401` on
> general endpoints like `/me`. That's expected and correct — don't worry about the 401.

---

## Prerequisites
- [Node.js](https://nodejs.org) LTS installed (gives you `npm`/`npx`).
- A Cloudflare account, a Telegram account, and paid Intercom + Fin.

## Generate secrets
PowerShell:
```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
Run it three times for `TELEGRAM_WEBHOOK_SECRET`, `GATEWAY_API_TOKEN`, `IDENTITY_SIGNING_SECRET`.

---

## Step A — Create the Telegram bot (~5 min)
1. In Telegram, open **@BotFather** → **Start**.
2. Send **/newbot** → choose a display name → choose a username ending in `bot`.
3. Copy the **HTTP API token** it gives you → this is `TELEGRAM_BOT_TOKEN`.
4. (Optional) `/setdescription`, `/setabouttext`, `/setuserpic`.

## Step B — Deploy the Worker (~20 min)
From this project folder:
```powershell
npm install                      # install wrangler + types
npx wrangler login               # opens browser, approve

# Create the KV namespace (note the printed id), then a preview id for local dev:
npx wrangler kv namespace create tg_fin_state
npx wrangler kv namespace create tg_fin_state --preview
```
Edit **wrangler.toml**:
- paste the two ids into the `[[kv_namespaces]]` block (`id` and `preview_id`);
- set `INTERCOM_BASE_URL` to your region (US `https://api.intercom.io`, EU `https://api.eu.intercom.io`, AU `https://api.au.intercom.io`).

Set the secrets (paste each value when prompted):
```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put INTERCOM_FIN_API_KEY
npx wrangler secret put INTERCOM_FIN_WEBHOOK_SECRET
npx wrangler secret put GATEWAY_API_TOKEN
npx wrangler secret put IDENTITY_SIGNING_SECRET
```
Deploy and note the URL it prints (e.g. `https://tg-fin-bridge.<you>.workers.dev`):
```powershell
npx wrangler deploy
```
Put that URL into `wrangler.toml` → `PUBLIC_BASE_URL`, then `npx wrangler deploy` once more
(so verification links point at the live Worker). Visiting the URL should show
`tg-fin-bridge: ok`.

## Step C — Intercom (Fin Agent API + data connectors)
**C0 — Custom attributes:** the bridge passes these on every message so Fin's Procedures can
use them: `verified`, `member_id`, `brand_id`, `language`, `channel`. Create matching custom
data attributes in Intercom (Settings → Data) so Fin recognizes them. (Unknown attributes are
reported back as non-fatal `errors` and otherwise ignored.)
**C1 — API key:** Intercom → **Fin AI Agent** → **Deploy** → **Fin Agent API** → generate a key
→ `INTERCOM_FIN_API_KEY`. (Already done ✅ — verified working against your workspace.)
**C2 — Webhook:** point Fin's webhook callback at `<PUBLIC_BASE_URL>/fin/webhook` and copy the
signing secret → `INTERCOM_FIN_WEBHOOK_SECRET`. (We'll find the exact screen for this together
after deploy; it lives with the Fin Agent API settings.)
**C3 — Data Connectors (Actions):** create three GET connectors, each sending header
`Authorization: Bearer <GATEWAY_API_TOKEN>`:
| Connector | URL |
|---|---|
| `dc_get_kyc_case` | `<PUBLIC_BASE_URL>/api/kyc?member_id={member_id}` |
| `dc_get_deposit_status` | `<PUBLIC_BASE_URL>/api/deposit?member_id={member_id}&deposit_id={deposit_id}` |
| `dc_get_withdrawal_status` | `<PUBLIC_BASE_URL>/api/withdrawal?member_id={member_id}&withdrawal_id={withdrawal_id}` |
`member_id` comes from the verified user's custom attributes; `deposit_id`/`withdrawal_id`
are collected by Fin from the player.
**C4 — Procedures:** build `proc_kyc_overall_status`, `proc_deposit_status`,
`proc_withdrawal_status` that (a) require `verified == true`, (b) call the matching connector,
(c) branch on status, (d) reply using the returned `user_safe_reason` / `failure_reason`
(never raw codes).
**C5 — Knowledge:** add some help content so Fin can answer general FAQs too.

## Step D — Point Telegram at the Worker (~2 min)
Open this URL in a browser (substitute your values):
```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<PUBLIC_BASE_URL>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```
Expect `{"ok":true,...}`. Check anytime with `.../getWebhookInfo`.

---

## Test it (milestones)
- **M1 pipe:** message the bot → you get a Fin reply. `npx wrangler tail` shows logs; `getWebhookInfo` shows 0 errors.
- **M2 identity:** send `/verify` → open the link → pick a demo member → bot confirms “verified”. (Demo members: `300425`, `300999`.)
- **M3 data:** as a verified user ask *"status of deposit DEP-260603-001?"* → Fin returns payment/posting/ETA with the account masked and no internal codes. An unverified user is asked to verify first.
- **M4 demo script:** run the source doc's §12 script end-to-end, in English and 中文.

Quick gateway check (without Fin), using your `GATEWAY_API_TOKEN`:
```powershell
curl.exe -H "Authorization: Bearer <GATEWAY_API_TOKEN>" "<PUBLIC_BASE_URL>/api/deposit?member_id=300425&deposit_id=DEP-260603-001"
```

## Local development
```powershell
copy .dev.vars.example .dev.vars   # fill in values; never commit this file
npx wrangler dev
```

---

## Project structure
| File | Purpose |
|---|---|
| `src/index.ts` | Router / entry point |
| `src/telegram.ts` | Telegram inbound + `sendTelegramMessage` |
| `src/fin.ts` | Fin Agent API client + webhook signature (verified against Intercom 2.14 spec + a live `200`) |
| `src/finwebhook.ts` | Handles Fin's `fin_replied` → Telegram |
| `src/gateway.ts` | iGaming data endpoints + masking + safe-reason mapping |
| `src/identity.ts` | Mock signed-login + KV mapping |
| `src/mockdata.ts` | Sample members + KYC/deposit/withdrawal records |
| `src/kv.ts` | Typed KV helpers |
| `src/crypto.ts` / `src/html.ts` | HMAC/base64url + HTML→text helpers |

## Going to production later
- **Real data:** replace the lookups in `src/mockdata.ts` with real read-only iGaming API calls inside `src/gateway.ts`. The JSON contract stays the same, so Fin config is unchanged.
- **Real identity:** replace the mock page in `src/identity.ts` with your real iGaming login that returns a signed token; verify that token in `/verify/complete` instead of trusting the form.
- **Fin webhook signature:** `verifyFinWebhookSignature` in `src/fin.ts` assumes a hex HMAC-SHA256 of the raw body. If real webhook deliveries fail verification, check whether your workspace sends the signature base64-encoded and adjust there.

## Not in this phase
Lark escalation/tasks & status sync, real iGaming APIs, write operations, extra channels,
advanced analytics. (See the project plan / source doc for the full roadmap.)
