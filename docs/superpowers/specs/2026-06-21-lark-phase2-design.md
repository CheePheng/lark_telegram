# Lark Phase 2 — Design Spec

**Date:** 2026-06-21 · **Repo:** existing `tg-fin-bridge` Worker (same repo as Phase 1)

## Goal
When Fin detects an exception (SLA breach, stuck deposit, duplicate charge, manual review, etc.),
post a **structured interactive card** into a Lark **ops group chat** so the back-office team can act.
One-way (create only). Separate from the Phase-1 Intercom live handoff, which stays for live
customer chat.

## Decisions (from brainstorming)
- **Lark = internal ops; Intercom stays for live chat** — two distinct paths.
- **Interactive message card in an ops group** (not Lark Tasks API / Base).
- **One-way create** (doc's Phase-2 MVP; two-way sync deferred).
- **Lark access uncertain** → use the lowest-setup option + a mock fallback.

## Architecture
```
Fin Procedure detects an exception
   │ calls Fin Action "dc_create_lark_task"
   ▼
Worker  POST /api/lark-task   (auth: Bearer GATEWAY_API_TOKEN, same as data connectors)
   │ validate → dedupe (KV) → build card
   ▼
Lark custom-bot webhook  https://open.larksuite.com/open-apis/bot/v2/hook/<token>
   ▼
Structured card in the Ops group chat
```
**Trigger = Fin-driven** ("Fin creates a Lark task", per the doc). Alternative (gateway auto-fire on
exception data) was rejected: it fires even when Fin only wants to inform the player.

## Lark integration approach
- **Custom bot incoming webhook** (not a full Open-Platform app): in the ops group →
  Settings → Bots → Add Bot → Custom Bot → copy the **webhook URL**; enable **Signature
  Verification** → copy the secret. No tenant-admin app review needed.
- Worker POST body: `{ timestamp, sign, msg_type: "interactive", card }`.
- Signature: `sign = base64( HMAC-SHA256( key = `${timestamp}\n${secret}`, msg = "" ) )`, `timestamp` in seconds.
- **Mock fallback:** if `LARK_WEBHOOK_URL` is unset/placeholder, the Worker **logs** the card instead
  of posting — lets us build/test before Lark access is confirmed (demo now, prod-ready later).

## /api/lark-task contract (what Fin sends)
Minimal inputs; the Worker derives the rest:
```json
{ "member_id": "300425", "brand_id": "BRAND_A", "business_ref": "DEP-260603-001",
  "exception_type": "DEPOSIT_NOT_POSTED", "summary": "Paid but not posted beyond threshold",
  "source": "Telegram", "intercom_conversation_id": "CONV-78421" }
```
- Required: `member_id`, `business_ref`, `exception_type`.
- The Worker maps `exception_type` → **owner team + priority + title prefix** and builds the card.

## Exception types → owner team / priority (from doc §5–7)
| exception_type | team | priority |
|---|---|---|
| DEPOSIT_NOT_POSTED | WALLET_OPS | High |
| DEPOSIT_DUPLICATE | WALLET_OPS | Urgent |
| DEPOSIT_AMOUNT_MISMATCH | WALLET_OPS | Urgent |
| WITHDRAWAL_STALLED | PAYOUT_OPS | High |
| WITHDRAWAL_NOT_RETURNED | PAYOUT_OPS | Urgent |
| WITHDRAWAL_ACCOUNT_MISMATCH | RISK_OPS | Urgent |
| WITHDRAWAL_REPEATED_FAILURE | PAYOUT_OPS | High |
| KYC_SLA_BREACH | KYC_OPS | High |
| KYC_MANUAL_REVIEW | COMPLIANCE_OPS | High |
| KYC_EXCESSIVE_RETRIES | KYC_OPS | High |

## Card content (doc §9)
Title `[<prefix>] <business_ref>`; Member (+brand); Reference; Priority; Owner team; Source; Status
(Open); optional Issue summary; optional Intercom link; created timestamp. Header colour by priority
(Urgent=red, High=orange, Normal=blue).

## Idempotency (doc §11)
KV dedupe key `larktask:{business_ref}:{exception_type}` (24h TTL) → never post duplicate cards for
the same case.

## Owner-team routing
MVP: **one ops group**, owner team labelled on the card. Enhancement (later): per-team groups via
multiple webhook URLs keyed by team.

## Files
- `src/lark.ts` — exception→meta map, `buildCard`, `postLarkCard` (signature + mock fallback)
- `src/larktask.ts` — `POST /api/lark-task` handler (auth, validate, dedupe, build+post)
- `src/index.ts` — route `/api/lark-task`
- `src/kv.ts` — `alreadyEscalatedToLark` dedupe helper
- `src/env.ts` — `LARK_WEBHOOK_URL`, `LARK_WEBHOOK_SECRET`

## Error handling
Lark post failures are logged and return `{posted:false}` (never break Fin). Mock mode logs the card.
Dedupe prevents duplicates. Unknown `exception_type` → 400.

## Testing
- `curl POST /api/lark-task` (with `GATEWAY_API_TOKEN`) in **mock mode** → 200 + card logged.
- With real `LARK_WEBHOOK_URL` → card appears in the ops group.
- Dedupe: same payload twice → second returns `deduplicated:true`.
- End-to-end: Fin exception scenario → card in group.

## Out of scope (deferred)
Two-way status sync, card button callbacks, auto-close, per-team groups, Lark Tasks/Base, real
iGaming APIs.
