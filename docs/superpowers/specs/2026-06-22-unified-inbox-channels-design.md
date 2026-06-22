# Unified-Inbox Channels (Telegram + Lark) — Design Spec

> ⛔ **SUPERSEDED (2026-06-22).** The Phase-0 gate failed: native Fin only auto-answers Intercom-native
> channels (Messenger/WhatsApp/etc.), not API-created conversations for non-native channels like
> Telegram/Lark. Decision: stay on the **Fin Agent API + handoff** model and add Lark as a channel
> on it. See `2026-06-22-add-lark-channel.md`.

**Date:** 2026-06-22 · **Repo:** existing `tg-fin-bridge` Worker

## Goal (the boss's model)
Telegram and Lark are **customer channels** — like WhatsApp. A customer message lands as a
**conversation in one unified Intercom inbox**, with **full context/history**. **Fin (AI) answers,
and human agents reply in that same inbox** as "Ask Ada". Every reply (Fin *or* human) is delivered
back to the customer on their channel. There is **no internal-only Lark** — Lark is just another
customer channel. This **supersedes** the original doc's "Lark = internal escalation" model and the
Phase-2 escalation cards we built.

## What changes vs. today
- **Drop the Fin Agent API** for Telegram. Its conversations show as *"handled through an external
  system — agents can't reply from Intercom"*, which is exactly what the boss rejects.
- **Both channels move to the standard Conversations → inbox model**, where Fin answers natively and
  agents reply natively in one inbox.
- The **Lark escalation-card feature** (`lark.ts`/`larktask.ts`, gateway auto-escalation) is **set
  aside** (internal model the boss rejected). Code stays in the repo, unused, until/if needed.

## Architecture
```
Customer (Telegram / Lark)
   │  message
   ▼
Cloudflare Worker  (channel adapters)
   │  ensure Intercom contact (external_id per channel)
   │  create OR continue the customer's OPEN conversation  (standard Conversations API, from.type "user")
   ▼
Intercom  — ONE unified inbox, full history
   │  Fin auto-answers (native Fin on the inbox; uses KYC/deposit/withdrawal connectors)
   │  human agents reply in the same inbox (Ask Ada)
   │  every reply (Fin OR human) -> conversation part -> webhook
   ▼
Cloudflare Worker  /intercom/webhook
   │  relay the latest non-customer part back to the right channel
   ▼
Telegram sendMessage  /  Lark message API  -> customer
```

## ⚠️ Critical assumption (verified FIRST in the plan)
**Fin must auto-answer standard inbox conversations created via the API.** This depends on the
workspace's Fin/AI configuration. **Plan Task 1 is a live test**: create a conversation via the API
and confirm Fin replies. If it does → proceed. If not → we either enable Fin for these conversations
or, as a fallback, reconsider (documented in the plan). Everything else depends on this.

## Single workspace + credentials
One Intercom workspace only (the one hosting the **Lark_Telegram** app; the supplied general token
resolves to **DKM-IGAMING / `ln0m55fn`** — to be confirmed in Task 1). Needed:
- `INTERCOM_API_TOKEN` — general token, **read+write Conversations & Contacts** (used to create
  conversations, post the customer's messages, read state).
- `INTERCOM_CLIENT_SECRET` — the app's client secret (verify the standard webhook `X-Hub-Signature`).
- **Native Fin** enabled on the inbox (a workspace setting, not a credential).
- The **Fin Agent API key / webhook secret are no longer used** in this model.

## Components

### 1. Channel adapters (one interface, two implementations)
A small shared shape so the rest of the system is channel-agnostic:
- `inbound`: parse a channel update → `{ channel, channel_user_id, text, display_name }`.
- `outbound(channel, channel_user_id, text)`: deliver a message to that user on that channel.
- **Telegram** (`telegram.ts`, reworked): inbound from the existing webhook; outbound via `sendMessage`.
- **Lark** (`larkchannel.ts`, new): a Lark **custom app** (the "real account") with bot capability —
  - auth: `app_id` + `app_secret` → cached `tenant_access_token`;
  - inbound: subscribe to `im.message.receive_v1` events → Lark event webhook → Worker;
  - outbound: `POST /open-apis/im/v1/messages` (text) to the user/chat;
  - verify Lark event signature (Encrypt Key / Verification Token).

### 2. Conversation bridge (`intercom.ts`, extended)
- `ensureContact(channel, channel_user_id, name)` → contact id (cached in KV; `external_id` =
  `tg_{id}` / `lark_{id}`).
- `sendCustomerMessage(...)`: if the user has an **open** conversation, **reply** to it
  (`/conversations/{id}/reply`, `type:"user"`, `intercom_user_id`); else **create** one
  (`from.type:"user"` — required in this workspace). Store the mapping both ways.
- Reuse the open conversation so **context accumulates** (the boss's requirement). A conversation is
  considered closed when Intercom fires `conversation.admin.closed`.

### 3. Reply relay (`intercomwebhook.ts`, extended)
- Subscribe to the conversation reply topics. On each event, take the **latest part that is NOT the
  customer** — i.e. author type **admin (human)** *or* **bot/operator (Fin)** — and relay it to the
  customer's channel. **This is how Fin's AI replies reach the customer too.**
- **Loop prevention:** never relay parts authored by the customer (we created those). Track the last
  relayed part id per conversation to avoid duplicates.
- `conversation.admin.closed` → clear the open-conversation mapping so the next message starts fresh.

### 4. State (KV)
- `contact:{channel}:{channel_user_id}` → contact_id
- `conv:{channel}:{channel_user_id}` → open conversation_id (+ reverse `icid:{conversation_id}` →
  `{channel, channel_user_id}`)
- `lastpart:{conversation_id}` → last relayed conversation_part id (loop/dup guard)
- `tenant_token` → cached Lark tenant_access_token (with TTL)

### 5. Identity & data (unchanged in spirit)
- `/verify` still links a channel user → `member_id` (stored on the contact as an attribute) so Fin's
  KYC/deposit/withdrawal connectors work. Data connectors are reused (rebuilt in the workspace).

## Channel-agnostic routing key
Conversations are keyed by `{channel, channel_user_id}` so Telegram and Lark never collide, and the
relay always knows which channel to answer on.

## Error handling
- Lark `tenant_access_token` refresh on 401; channel send failures logged, not fatal.
- Webhook signature failures → 401.
- Eventual consistency on new contacts → retry conversation create (we already do this).
- If Fin doesn't auto-answer (Task 1 fails) → stop and revisit before building further.

## Testing
- Task 1: API-created conversation → Fin replies (the gate).
- Telegram (reworked): message → inbox conversation + Fin reply relayed back; human inbox reply
  relayed back; one inbox with full history.
- Lark: same, end-to-end, via the Lark app.
- Loop/dup: customer messages never echo back; no duplicate relays.

## Out of scope
- The internal escalation-card feature (superseded; code left dormant).
- Real iGaming APIs (still mock). WhatsApp/other channels. Two-way ticket sync beyond replies.

## Decomposition (build order)
1. **Phase 0:** verify Fin auto-answers API conversations (gate).
2. **Phase A:** rework **Telegram** onto the unified-inbox model (proves the whole pattern on a
   channel we already have).
3. **Phase B:** add the **Lark custom app** channel on the same model.

Each phase is independently testable; Phase A validates the architecture before we add Lark.
