# Monday.com Update — Telegram × Intercom Fin (Phase 1)
_Last updated: 21 Jun 2026 · Hosting: Cloudflare Workers · Worker: tg-fin-bridge.askada.workers.dev_

---

## 1) Telegram Integration  ·  配置 Telegram 集成
**Status: ✅ Working (core loop verified end-to-end)**

**What it does:** Players chat with our Intercom **Fin AI agent** directly inside **Telegram**. Messages flow both ways automatically.

**How it's built**
- **Telegram bot** `@FinAiHelper12037_Bot` (created via BotFather).
- **Cloudflare Worker** ("the bridge") connects Telegram ⇄ Intercom Fin Agent API.
- **Message flow:** player sends a message on Telegram → Worker forwards it to Fin (`/fin/start` / `/fin/reply`) → Fin's answer is delivered back to the Worker via a secured webhook → Worker posts it to the player on Telegram.
- **Security:** Telegram secret token + HMAC-signed Fin webhook (signature verified on every event). All credentials stored as Cloudflare secrets (none in code).
- **Reliability:** conversations self-heal (auto-start a fresh thread if an old one is unknown).

**Bot commands:** `/start` (welcome), `/verify` (link account), `/reset` (clear conversation / fresh start).

**Verified:** Player message → Fin reply confirmed live in Telegram. ✔️

**Dependency note:** Original Intercom workspace didn't expose the Fin Agent API webhook config; account manager provisioned a **new workspace** with full Fin Agent API access, now in use.

---

## 2) Deposit, Withdrawal & KYC — Integration Configuration  ·  数据集成配置
**Status: ✅ Done — all 3 data connectors live & tested**

**What it does:** Gives Fin secure, read-only access to player account data (KYC / deposit / withdrawal) so it can answer with real figures instead of generic info.

**How it's built**
- **Data gateway** (Cloudflare Worker endpoints) that Fin calls:
  - `GET /api/kyc?member_id=…`
  - `GET /api/deposit?member_id=…&deposit_id=…`
  - `GET /api/withdrawal?member_id=…&withdrawal_id=…`
- **3 Intercom Data Connectors** created and set **live**: *Get deposit status*, *Get KYC status*, *Get withdrawal status* — each authenticates to the gateway with a bearer token and passes the player's inputs.
- **Data protection built in (per the use-case doc):**
  - **Masking** — e.g. payout account returned as `****8821`, never the full number.
  - **Safe-reason mapping** — internal risk/error codes are translated to approved customer-facing wording; raw codes are never exposed.
  - **Read-only** — no write access to core systems.
- **Each connector tested** against the live gateway (200 OK with correct, masked data).

**Important:** data is currently **mock/sample** (realistic, matching the doc's fields). The design isolates this so the **real iGaming APIs can be swapped in later with no change to the Intercom configuration**.

---

## 3) Procedure — Deposit, Withdrawal & KYC  ·  流程
**Status: ✅ Configured & verified for all 3 scenarios**

**What it does:** Defines *when and how* Fin uses each data connector to handle a player's question, and the safe response it returns.

**How it works**
- Each connector runs in Fin's **"Directly"** mode: Fin reads the question, decides which connector applies, and **collects the required details from the player** (member ID + the relevant reference number) before calling it.
- **Per-scenario behaviour:**
  - **Deposit** — "my deposit hasn't arrived" → Fin asks for member ID + deposit reference → returns payment status, wallet-posting status, ETA, in safe wording (e.g. *"confirmed as paid, wallet credit in progress, expected …"*).
  - **KYC** — "what's my verification status?" → asks for member ID → returns current stage, safe reason, required action, ETA.
  - **Withdrawal** — "where is my withdrawal?" → asks for member ID + withdrawal reference → returns status, **masked** payout account, ETA, whether funds were returned.
- **Identity/Security:** member identity is handled by our own secure verify flow; the gateway also validates that the record belongs to the member. (Intercom's built-in customer-auth challenge is off for the demo.)

**Verified live on Telegram:** all three scenarios return correct, masked, safe answers. ✔️

**Next (not yet done):** human handoff (escalations into the Intercom inbox with the agent's reply routed back to the player), multilingual EN/中文 pass, and final end-to-end demo run.
