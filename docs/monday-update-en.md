# iGaming AI Customer Service — Lark + Telegram × Intercom Fin (Final Status)

**Status: ✅ LIVE on both channels (Lark + Telegram).**

## 1. What it does
Customers chat on **Lark** and **Telegram** as if messaging a real agent. Each message becomes a **real, replyable Intercom conversation** where:
- **Fin AI** answers automatically (including **live deposit/withdrawal status** lookups), and
- a **human agent can take over in the same conversation** — their replies go straight back to the customer's Lark/Telegram.

All channels land in **one Intercom inbox** (workspace: DKM-IGAMING). Runs **serverless on Cloudflare** (no servers to manage).

## 2. Delivered capabilities
- **Two customer channels** — Lark (custom app "Ask Ada") + Telegram bot → one inbox.
- **AI auto-answer** — Fin replies from your knowledge base inside the conversation.
- **Live data** — Fin pulls real-time **deposit** and **withdrawal** status via Data Connectors, with **masking** (e.g. card shown as `****8821`) and **safe wording** (no internal codes leaked).
- **Two-way human handoff** — agent replies in Intercom relay back to the channel (👤); customer replies relay into the same conversation.
- **One conversation per customer** — follow-ups stay in the same thread; a new one opens only after reset/close.
- **Multilingual** — Fin can reply in the customer's language (Intercom Fin language setting; Chinese enabled).
- **Reliability built in** — duplicate-message protection, no echo loops, fast acknowledgement so messages never get dropped/duplicated, clickable source links.

## 3. How it works (high level)
```
Customer (Lark/Telegram) → Cloudflare Worker → creates/uses one Intercom conversation
   → Intercom Workflow runs Fin (answers + live-data lookup)
   → Worker relays Fin's answer back to the channel
   → Human agent can reply in the same conversation → relayed back to the channel
```
- **Cloudflare Worker** = the backend brain (routing, channel adapters, the Intercom bridge, the data gateway). URL: `tg-fin-bridge.askada.workers.dev`.
- **Cloudflare KV** = state store (maps each customer to their Intercom conversation).
- **Intercom Workflow** ("Customer sends first message" → Let Fin handle) drives Fin in the conversation.
- Fin's answers are relayed by **polling** (Fin's bot replies don't emit a webhook); human replies relay via the **standard webhook**.

## 4. What's configured
- **Lark**: custom app with bot + scopes (incl. `im:message.p2p_msg`), event `im.message.receive_v1`, webhook → our Worker.
- **Intercom**: `source_channel` contact attribute; Workflow (audience lark/telegram → Fin); 2 Data Connectors (deposit, withdrawal); multilingual.
- **Cloudflare**: Worker deployed; KV bound; all credentials stored as encrypted secrets (none in code); per-channel feature flag `INTERCOM_WORKFLOW_BRIDGE = "lark,telegram"`.

## 5. Demo / verification
Send in Lark or Telegram:
- `how do i check my deposit?` → Fin answers from knowledge.
- `deposit hasn't arrived — member 300425, deposit DEP-260603-001` → Fin returns live status + ETA.
- `where is my withdrawal — member 300425, withdrawal WD-260612-006` → status + masked account.
- `talk to a human` → handover; agent reply in Intercom reaches the channel.

## 6. Notes / optional next steps
- **iGaming data is currently mocked** — production swap is isolated to the data gateway; the contract to Fin stays the same.
- Optional: tune Fin's auto-close timing, AI handover summary, and add more channels (the code is channel-agnostic — each channel = one small adapter).
- Full technical doc (Chinese) and architecture are in the repo (`docs/`).

**Bottom line:** the end-to-end system (Lark + Telegram → Fin + live data + human handoff, one inbox) is built, deployed, and verified working.
