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

---

## 4) Human Handoff / Live Agent  ·  人工转接
**Status: ✅ Done — two-way live, verified**

**What it does:** When Fin can't help (or the player asks for a human), the chat hands off to a **live agent in the Intercom inbox**, and the agent and player chat in real time through Telegram.

**How it works**
- Player triggers escalation (e.g. *"I want to talk to a human"*) → the bridge opens a **real, repliable Intercom inbox conversation** (named `Telegram <id>`) and tells the player they're connected.
- **Player → inbox:** the player's Telegram messages appear inside that inbox conversation.
- **Agent → player:** the agent's inbox replies are delivered back to the player on Telegram (shown with a 👤 marker).
- **Close-out:** when the agent closes the conversation (or the player types `/reset`), the player is returned to Fin automatically.
- **Lifecycle:** one open handoff per player; repeat requests reuse the same conversation; after it closes, the next escalation opens a fresh one.
- **Security:** webhook signatures verified (HMAC); credentials stored as secrets.

**Verified live on Telegram + Intercom inbox:** escalation → inbox conversation → agent reply → player → close → back to Fin. ✔️

---

## 5) Identity Verification  ·  身份验证
**Status: ✅ Done (demo) — secure-link mechanism live**

**What it does:** Lets a player securely link their Telegram chat to their iGaming account before account data is shown — per the document's "never trust a Telegram username alone" rule.

**How it works**
- Player sends `/verify` → receives a secure, single-use link → confirms identity → the bridge records the verified Telegram ↔ member link (signed-token mechanics are production-grade).
- **Demo note:** the link currently uses a demo login (pick a sample member). For production, swap in the real iGaming login that returns a signed token — no other changes needed.

**Verified live on Telegram.** ✔️

---

## Overall status (21 Jun 2026)
**Phase 1 COMPLETE & demo-ready:** Telegram ↔ Fin AI, live (mock) KYC/deposit/withdrawal answers with masking + safe wording, identity verification, and two-way human handoff in the Intercom inbox. Deployed on Cloudflare; version-controlled in git.

**Optional refinement:** wire `/verify` directly into the data lookups so verified players don't re-enter their member ID and data is gated on verification (extra Intercom config).

**Deferred to Phase 2:** Lark internal-collaboration loop; real iGaming APIs (currently mock); multilingual polish pass.
