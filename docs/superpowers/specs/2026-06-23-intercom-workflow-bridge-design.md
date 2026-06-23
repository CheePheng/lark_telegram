# Intercom Workflow Bridge — Design

**Status:** validated by live probe (2026-06-23). Behind feature flag `INTERCOM_WORKFLOW_BRIDGE`.

## Problem

The boss wants the Lark/Telegram message to **become the actual Intercom conversation**, so Fin **and** human agents answer in the **same, replyable thread** — no mirrored copy, and not the Fin Agent API's read-only "external system" thread.

Two prior approaches and why they fall short:
- **Fin Agent API** (current default): creates a conversation flagged "handled through an external system" → **read-only** in Intercom; agents cannot reply there. Cannot be made writable.
- **Canonical mirror** (committed `3cfdc76`): mirrors messages into a separate replyable conversation. Works, but the boss explicitly does **not** want a mirror.

## Validated feasibility (live probe, 2026-06-23, DKM-IGAMING)

1. `POST /conversations {from:{type:"user",id},body}` creates a **`customer_initiated`**, `source.type:"conversation"` (Messenger/"Web") conversation that is **replyable — no external banner**. ✅
2. A contact custom attribute **`source_channel`** (People attribute, Text) can be set via the REST API even with "Require verified updates" on (REST = authenticated). ✅
3. An Intercom **Workflow** — trigger **"Customer sends their first message"**, channels **Web/iOS/Android**, audience **Custom: Users + `source_channel is lark`**, step **"Let Fin handle / Use your content"** — **fired on the API-created conversation and Fin answered inside it** (parts authored by `bot Fin`, `part_type:"comment"`). ✅

Conclusion: Intercom **can** be the source-of-truth conversation for a non-native channel, *if* the conversation is created via the Conversations API and a Workflow scoped by `source_channel` runs Fin.

## Goal

When `INTERCOM_WORKFLOW_BRIDGE=true`, a Lark (and later Telegram) customer message creates/continues a **normal Intercom conversation**; an Intercom Workflow lets **Fin** answer in it; **human agents** can reply in the same thread; the Worker **relays Fin + agent replies back** to the channel. No Fin Agent API, no mirror.

When the flag is `false` (default), behaviour is unchanged (the existing committed flow).

## Architecture

```
Lark/Telegram msg → larkchannel/telegram → routeInbound (inbound.ts)
  if INTERCOM_WORKFLOW_BRIDGE:
    • ensureWorkflowContact: contact external_id `${channel}_${cuid}`,
        name `IGaming ${Channel}`, custom_attributes { source_channel: channel }
    • active conversation? (KV wf:{channel}:{cuid})
        - none → POST /conversations (from.type "user", body=text)
                 store wf:{channel}:{cuid}→conv_id  and  icid:{conv_id}→{channel,cuid}
        - exists → POST /conversations/{id}/reply (type "user", body=text)
    • (no Fin Agent API call)
        ↓
  Intercom Workflow (trigger "first message", audience source_channel=<channel>, channel Web)
        → Fin answers IN the conversation (bot parts); human agents may also reply (admin parts)

/intercom/webhook  (INTERCOM_WORKFLOW_BRIDGE path)
  • on a new Fin (author "bot") or agent (author "admin") COMMENT part:
        relay its text → sendToChannel(channel, cuid, …)
  • skip author "user" (customer's own mirrored message) and notes
  • dedupe by conversation-part id (KV, TTL)
  • on conversation.admin.closed → clear wf:{channel}:{cuid} + icid:{conv}
        (next customer message creates a fresh conversation → re-triggers the Workflow)
```

## Components / files

| File | Change |
|---|---|
| `src/env.ts` | add `INTERCOM_WORKFLOW_BRIDGE: string` + `workflowBridge(env): boolean` helper |
| `wrangler.toml` | add `INTERCOM_WORKFLOW_BRIDGE = "false"` under `[vars]` |
| `src/kv.ts` | `getWorkflowConversation/setWorkflowConversation/clearWorkflowConversation` (`wf:{channel}:{cuid}` ↔ `icid:{conv}`); reuse `alreadyRelayedPart` (exists) |
| `src/intercom.ts` | `ensureWorkflowContact(channel,cuid)` (sets `source_channel`), `ensureWorkflowConversation(channel,cuid,text)` (create-or-reply, self-heal); reuse `replyAsUser`, `ensureContact` patterns |
| `src/inbound.ts` | `routeInbound`: if `workflowBridge(env)` → workflow path; else existing path |
| `src/intercomwebhook.ts` | if `workflowBridge(env)` → relay **bot+admin** comments (dedupe, skip user/notes), clear wf on close; else existing (admin only) |
| `src/larkchannel.ts`, `src/telegram.ts`, `src/fin.ts`, `src/finwebhook.ts` | unchanged (finwebhook simply isn't exercised when flag on) |

## Build-time unknowns (resolve as first tasks)

1. **Does a Fin (author "bot") reply fire a webhook to `/intercom/webhook`?** `conversation.admin.replied` may cover only human admins. **Task 1:** with the flag on and the Workflow live, send a Lark message and watch `wrangler tail` — confirm a webhook fires for the Fin bot reply.
   - If `conversation.admin.replied` fires for bot replies → relay author `bot` + `admin`.
   - If a different topic fires (e.g. an AI-agent/bot topic) → subscribe to it in the Developer Hub app.
   - If **no** webhook fires for bot replies → fallback: after posting the customer message, short-poll `GET /conversations/{id}` (a few attempts) for new `bot`/`admin` comment parts and relay them. (Agent/human replies relay via `conversation.admin.replied` regardless.)
2. **Does Fin answer follow-up messages in the same open conversation** (not only the first)? Expected yes (Fin "handles" the conversation once routed to it). **Task 2:** send a 2nd question in the same conversation and confirm Fin answers + it relays. If Fin only answers the first message, revisit (e.g. resolve+recreate per message, or a different trigger).

## Error handling / edge cases

- **Closed/deleted conversation:** `ensureWorkflowConversation` recreates on reply failure and updates KV; a fresh conversation re-triggers the Workflow.
- **Dedupe:** every relayed part id stored with 24h TTL; webhook retries are ignored.
- **No echo:** customer messages are posted as author `user`; the relay explicitly skips `user` parts.
- **Notes/assignments/attribute updates:** ignored (only `part_type:"comment"` from `bot`/`admin` is relayed).
- **Flag off:** zero behaviour change.

## Acceptance criteria

1. Lark: "how do I check my deposit?" → a **normal `IGaming Lark` conversation** (no external banner) → **Fin answers in it** → answer **relayed to Lark**.
2. Follow-up Lark question → Fin answers in the **same** conversation → relayed (Task 2).
3. A **human agent** types in that conversation → relayed to Lark (`👤`).
4. Agent **closes** the conversation → next Lark message starts a **fresh** conversation (Workflow re-triggers).
5. **No** mirror/duplicate conversation; **no** echo loops; **no** duplicate relays.
6. Flag off → existing behaviour intact.

## Scope / out of scope

- **In:** Lark first; code is channel-agnostic so Telegram works by adding `source_channel=telegram` to the Workflow audience (or a second Workflow).
- **Out:** removing the Fin Agent API or mirror code (kept as fallback / history); the Intercom Workflow UI config (done by the user); real iGaming data (still mocked).

## User-side prerequisites (Intercom UI)

- People attribute **`source_channel`** (Text) — created. ✅
- Workflow: trigger "Customer sends their first message", channels include **Web**, audience **Users + `source_channel is lark`**, step **Let Fin handle (Use your content)**, **Live**. ✅ (extend audience to `telegram` later)
- Developer Hub app webhook: may need an extra topic subscription for Fin/bot replies (decided by Task 1).
