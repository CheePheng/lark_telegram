# Intercom Workflow Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No unit-test harness in this repo.** Verify code tasks with `npm run typecheck`; verify runtime tasks with deploy + a live message + API/`wrangler tail` inspection.
> PowerShell setup for every shell task: `$env:Path = "C:\Program Files\nodejs;$env:Path"` and `$env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"`.

**Goal:** Make a Lark (and later Telegram) message *become* a normal, replyable Intercom conversation where an Intercom Workflow lets Fin answer, a human agent can reply in the same thread, and the Worker relays Fin + agent replies back to the channel — all behind `INTERCOM_WORKFLOW_BRIDGE` (per-channel flag). Flag off = today's behaviour.

**Architecture:** On inbound (flag on for the channel), create the conversation via the Conversations API (`from.type:"user"`, contact tagged `source_channel`) on first message, or reply as the contact on later messages. The Intercom Workflow (configured in the UI, audience `source_channel is <channel>`) runs Fin inside that conversation. `/intercom/webhook` relays new Fin (`author:"bot"`) and agent (`author:"admin"`) comment parts back to the channel, deduped by part id; on close it clears the mapping so the next message starts fresh. No Fin Agent API in this mode.

**Tech Stack:** Cloudflare Workers + KV (TypeScript), Intercom Conversations API + standard webhook (`conversation.admin.replied`/`closed`), Lark/Telegram adapters (existing).

**Spec:** `docs/superpowers/specs/2026-06-23-intercom-workflow-bridge-design.md`. Validated by live probe 2026-06-23 (Workflow + Fin answered an API conversation).

---

## File changes

| File | Responsibility |
|---|---|
| `src/env.ts` | `INTERCOM_WORKFLOW_BRIDGE` var + `workflowBridge(env, channel)` helper |
| `wrangler.toml` | `INTERCOM_WORKFLOW_BRIDGE = "false"` under `[vars]` |
| `src/kv.ts` | `WorkflowConversation` + `get/set/clearWorkflowConversation` (`wf:{channel}:{cuid}` ↔ `icid:`); reuse `alreadyRelayedPart` |
| `src/intercom.ts` | `ensureWorkflowContact`, `ensureWorkflowConversation` (reuse `createConversation`/`replyAsUser`/`escapeHtml`/`contactName`) |
| `src/inbound.ts` | `routeInbound`: per-channel flag branch → workflow path |
| `src/intercomwebhook.ts` | flag branch → relay bot+admin comments (dedupe, skip user/notes); clear workflow mapping on close |

`src/larkchannel.ts`, `src/telegram.ts`, `src/fin.ts`, `src/finwebhook.ts` are unchanged (finwebhook is simply not exercised when the flag is on).

---

## Task 0: Per-channel feature flag

**Files:** Modify `src/env.ts`, `wrangler.toml`

- [ ] **Step 1: Add the var to the `Env` interface.** In `src/env.ts`, inside the `// Public vars` block (after `ALLOW_UNVERIFIED_CHAT: string;`), add:

```typescript
  INTERCOM_WORKFLOW_BRIDGE: string; // "false" | "lark" | "telegram" | "lark,telegram" | "all"
```

- [ ] **Step 2: Add the helper.** At the end of `src/env.ts`, after `allowUnverifiedChat`, add:

```typescript
import type { Channel } from "./kv";

/** True if the Intercom Workflow Bridge is enabled for this channel. */
export function workflowBridge(env: Env, channel: Channel): boolean {
  const v = (env.INTERCOM_WORKFLOW_BRIDGE ?? "false").toLowerCase().trim();
  if (v === "true" || v === "all") return true;
  return v.split(",").map((s) => s.trim()).includes(channel);
}
```

> Note: `env.ts` currently has no imports. Adding `import type { Channel } from "./kv"` is fine (type-only, no cycle at runtime).

- [ ] **Step 3: Add the var to `wrangler.toml`.** In the `[vars]` section, add:

```toml
INTERCOM_WORKFLOW_BRIDGE = "false"
```

- [ ] **Step 4: Typecheck.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck`
Expected: no output / exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/env.ts wrangler.toml
git commit -m "feat(wf-bridge): add INTERCOM_WORKFLOW_BRIDGE per-channel flag"
```

---

## Task 1: KV workflow-conversation mapping

**Files:** Modify `src/kv.ts`

- [ ] **Step 1: Add the helpers.** In `src/kv.ts`, immediately after the canonical-conversation section (after `clearCanonicalConversation`), add:

```typescript
// --- workflow-bridge conversation -----------------------------------------
// The Lark/Telegram message IS this Intercom conversation (created via the
// Conversations API). An Intercom Workflow runs Fin inside it; agents reply in
// it; we relay replies back. (Distinct from the canonical-mirror records.)
export interface WorkflowConversation {
  conversation_id: string;
  contact_id: string;
  updated_at: string;
}

export async function getWorkflowConversation(env: Env, channel: Channel, cuid: string): Promise<WorkflowConversation | null> {
  return env.TG_FIN_STATE.get<WorkflowConversation>(`wf:${channel}:${cuid}`, "json");
}

/** Store the workflow conversation and keep the reverse `icid` lookup in sync. */
export async function setWorkflowConversation(env: Env, channel: Channel, cuid: string, rec: WorkflowConversation): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.put(`wf:${channel}:${cuid}`, JSON.stringify(rec)),
    env.TG_FIN_STATE.put(`icid:${rec.conversation_id}`, JSON.stringify({ channel, cuid } satisfies UserRef)),
  ]);
}

export async function clearWorkflowConversation(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  await Promise.all([
    env.TG_FIN_STATE.delete(`wf:${channel}:${cuid}`),
    env.TG_FIN_STATE.delete(`icid:${conversationId}`),
  ]);
}
```

- [ ] **Step 2: Typecheck.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add src/kv.ts
git commit -m "feat(wf-bridge): KV workflow-conversation mapping helpers"
```

---

## Task 2: Intercom workflow helpers

**Files:** Modify `src/intercom.ts`

- [ ] **Step 1: Import the KV helpers.** In `src/intercom.ts`, extend the existing `from "./kv"` import to also import the workflow helpers. Change the import block to:

```typescript
import {
  getContactId, setContactId, clearContactId, setHandoff, clearHandoff,
  getCanonicalConversation, setCanonicalConversation, clearCanonicalConversation, type CanonicalConversation,
  getWorkflowConversation, setWorkflowConversation, clearWorkflowConversation,
} from "./kv";
```

- [ ] **Step 2: Add the two helpers.** At the end of `src/intercom.ts`, add:

```typescript
// ===========================================================================
// Workflow Bridge — the Lark/Telegram message IS a normal Intercom conversation.
// We tag the contact with source_channel so an Intercom Workflow can target it
// and let Fin answer in-thread. (Fin's own Fin-Agent-API thread is NOT used here.)
// ===========================================================================

/** Ensure a contact tagged with source_channel=<channel> so the Workflow audience matches. */
export async function ensureWorkflowContact(env: Env, channel: Channel, cuid: string): Promise<string> {
  const attrs = { custom_attributes: { source_channel: channel }, name: contactName(channel) };
  const cached = await getContactId(env, channel, cuid);
  if (cached) {
    await fetch(`${env.INTERCOM_BASE_URL}/contacts/${cached}`, {
      method: "PUT",
      headers: headers(env),
      body: JSON.stringify(attrs),
    }).catch(() => {});
    return cached;
  }
  const res = await fetch(`${env.INTERCOM_BASE_URL}/contacts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ role: "user", external_id: `${channel}_${cuid}`, ...attrs }),
  });
  let id: string | null = null;
  if (res.ok) id = ((await res.json()) as { id?: string }).id ?? null;
  else id = await findContactByExternalId(env, `${channel}_${cuid}`);
  if (!id) throw new Error(`ensureWorkflowContact failed: ${res.status} ${await res.text().catch(() => "")}`);
  await setContactId(env, channel, cuid, id);
  return id;
}

/** First message → create the conversation (Workflow + Fin engage). Later messages → reply as the contact. */
export async function ensureWorkflowConversation(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  const existing = await getWorkflowConversation(env, channel, cuid);
  if (existing) {
    try {
      await replyAsUser(env, existing.conversation_id, existing.contact_id, text); // reopens if it was closed
      return;
    } catch {
      await clearWorkflowConversation(env, channel, cuid, existing.conversation_id); // gone -> recreate below
    }
  }
  let contactId = await ensureWorkflowContact(env, channel, cuid);
  let conversationId: string;
  try {
    conversationId = await createConversation(env, contactId, escapeHtml(text));
  } catch {
    // Cached contact may be stale (e.g. different workspace) -> recreate and retry.
    await clearContactId(env, channel, cuid);
    contactId = await ensureWorkflowContact(env, channel, cuid);
    conversationId = await createConversation(env, contactId, escapeHtml(text));
  }
  await setWorkflowConversation(env, channel, cuid, {
    conversation_id: conversationId,
    contact_id: contactId,
    updated_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 3: Typecheck.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck`
Expected: exit 0. (If "clearWorkflowConversation is declared but never read" appears, it is used in `ensureWorkflowConversation` above — re-check the edit landed.)

- [ ] **Step 4: Commit.**

```bash
git add src/intercom.ts
git commit -m "feat(wf-bridge): ensureWorkflowContact + ensureWorkflowConversation"
```

---

## Task 3: Inbound branch

**Files:** Modify `src/inbound.ts`

- [ ] **Step 1: Add imports.** At the top of `src/inbound.ts`, add `workflowBridge` and `ensureWorkflowConversation`:

```typescript
import { workflowBridge } from "./env";
import { mirrorCustomerToIntercom, ensureWorkflowConversation } from "./intercom";
```
(Replace the existing `import { mirrorCustomerToIntercom } from "./intercom";` line with the combined one above; keep the existing `import type { Env } from "./env";` line.)

- [ ] **Step 2: Branch at the top of `routeInbound`.** Change the body of `routeInbound` so the workflow path runs first:

```typescript
export async function routeInbound(env: Env, channel: Channel, cuid: string, text: string, language?: string): Promise<void> {
  // Workflow Bridge: the message IS the Intercom conversation; an Intercom Workflow
  // + Fin answer inside it, and /intercom/webhook relays replies back. No Fin Agent API.
  if (workflowBridge(env, channel)) {
    await ensureWorkflowConversation(env, channel, cuid, text);
    return;
  }

  // --- existing canonical-mirror path (flag off) ---
  await mirrorCustomerToIntercom(env, channel, cuid, text);

  const handoff = await getHandoff(env, channel, cuid);
  if (handoff?.state === "open") return;

  await forwardToFin(env, channel, cuid, text, language);
}
```

- [ ] **Step 3: Typecheck.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
git add src/inbound.ts
git commit -m "feat(wf-bridge): route inbound through workflow conversation when flag on"
```

---

## Task 4: Relay Fin + agent replies (and verify the webhook topic)

**Files:** Modify `src/intercomwebhook.ts`

This task contains the spec's **build-time unknown #1** (does a Fin/bot reply fire a webhook?). Implement the relay, deploy with the flag on for Lark, then verify live.

- [ ] **Step 1: Imports.** In `src/intercomwebhook.ts`, update imports:

```typescript
import { getUserByIntercomConversation, alreadyRelayedPart, clearWorkflowConversation } from "./kv";
import { htmlToPlainText } from "./html";
import { sendToChannel } from "./channels";
import { endHandoff } from "./intercom";
import { workflowBridge } from "./env";
```

- [ ] **Step 2: Branch the `conversation.admin.replied` handler.** Replace the existing `if (topic === "conversation.admin.replied") { ... }` block with:

```typescript
  if (topic === "conversation.admin.replied") {
    const parts: ConversationPart[] = convo?.conversation_parts?.conversation_parts ?? [];

    if (workflowBridge(env, ref.channel)) {
      // Relay every NEW Fin (bot) + agent (admin) comment, in order, deduped by part id.
      // Skip the customer's own (author "user") and notes — no echo.
      for (const p of parts) {
        if (p.part_type !== "comment") continue;
        const at = p.author?.type ?? "";
        if (at !== "bot" && at !== "admin") continue;
        if (!p.body) continue;
        if (p.id && (await alreadyRelayedPart(env, p.id))) continue;
        const prefix = at === "admin" ? "👤 " : ""; // Fin answers plain; human prefixed
        await sendToChannel(env, ref.channel, ref.cuid, `${prefix}${htmlToPlainText(String(p.body))}`);
      }
      return ok();
    }

    // --- mirror/handoff mode (flag off): newest human-agent comment only ---
    const last = [...parts].reverse().find((p) => p.part_type === "comment" && p.author?.type === "admin");
    if (last?.body) {
      if (last.id && (await alreadyRelayedPart(env, last.id))) return ok();
      await sendToChannel(env, ref.channel, ref.cuid, `👤 ${htmlToPlainText(String(last.body))}`);
    }
    return ok();
  }
```

- [ ] **Step 3: Branch the close handler.** Replace the existing `if (topic === "conversation.admin.closed" ...) { ... }` block with:

```typescript
  if (topic === "conversation.admin.closed" || topic === "conversation.closed") {
    if (workflowBridge(env, ref.channel)) {
      // Clear the mapping so the next customer message creates a fresh conversation
      // (which re-triggers the "Customer sends their first message" Workflow).
      await clearWorkflowConversation(env, ref.channel, ref.cuid, intercomId);
    } else {
      await endHandoff(env, ref.channel, ref.cuid);
    }
    await sendToChannel(env, ref.channel, ref.cuid, "✅ This chat is closed. Send a new message and we'll be glad to help again.");
    return ok();
  }
```

- [ ] **Step 4: Typecheck.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/intercomwebhook.ts
git commit -m "feat(wf-bridge): relay Fin+agent replies; clear mapping on close"
```

- [ ] **Step 6: Enable the flag for Lark and deploy.** In `wrangler.toml`, set `INTERCOM_WORKFLOW_BRIDGE = "lark"` (Telegram stays on the old path — protects it). Then:

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"; npx wrangler deploy`
Expected: "Deployed tg-fin-bridge".

- [ ] **Step 7: VERIFY the webhook topic (build-time unknown #1).** Start `npx wrangler tail tg-fin-bridge --format json | Out-File -Encoding utf8 wf_tail.log` in the background. Have the user DM the Lark bot **"how do i check my deposit?"**. Then inspect:
  - In Lark: did Fin's answer arrive back?
  - In `wf_tail.log`: did `/intercom/webhook` fire, with a `conversation.admin.replied` topic, containing a `part_type:"comment"` `author.type:"bot"` part?

  Decision:
  - **Fin answer arrived in Lark** → topic works; done. Proceed to Task 5.
  - **`/intercom/webhook` fired but no bot part relayed** → inspect the payload's `author.type` for Fin (could be `"bot"`, `"operator"`, etc.); widen the allowed types in Step 2 accordingly; redeploy.
  - **No `/intercom/webhook` fired for the Fin reply at all** → Fin/bot replies don't emit `conversation.admin.replied`. Apply the **poll fallback (Task 4b)**.

## Task 4b (only if Step 7 shows no webhook for Fin replies): poll fallback

**Files:** Modify `src/intercom.ts`, `src/inbound.ts`

- [ ] **Step 1: Add a poll-and-relay helper** to `src/intercom.ts`:

```typescript
import { sendToChannel } from "./channels"; // already imported at top — do not duplicate
import { htmlToPlainText } from "./html";
import { alreadyRelayedPart, getWorkflowConversation } from "./kv";

/** Poll a workflow conversation for new Fin/agent comments and relay them. Used when
 *  Fin (bot) replies don't emit a webhook. Call via ctx.waitUntil so it runs after we ack. */
export async function pollAndRelayWorkflow(env: Env, channel: Channel, cuid: string, conversationId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`${env.INTERCOM_BASE_URL}/conversations/${conversationId}?display_as=plaintext`, { headers: headers(env) });
    if (!res.ok) continue;
    const data = (await res.json()) as { conversation_parts?: { conversation_parts?: Array<{ id?: string; part_type?: string; body?: string; author?: { type?: string } }> } };
    const parts = data.conversation_parts?.conversation_parts ?? [];
    for (const p of parts) {
      if (p.part_type !== "comment") continue;
      const at = p.author?.type ?? "";
      if (at !== "bot" && at !== "admin") continue;
      if (!p.body) continue;
      if (p.id && (await alreadyRelayedPart(env, p.id))) continue;
      const prefix = at === "admin" ? "👤 " : "";
      await sendToChannel(env, channel, cuid, `${prefix}${htmlToPlainText(String(p.body))}`);
    }
  }
}
```

- [ ] **Step 2: Trigger the poll after creating/replying.** This requires `ctx` in the inbound path. In `src/inbound.ts`, after `ensureWorkflowConversation(...)`, look up the conversation and schedule the poll:

```typescript
  if (workflowBridge(env, channel)) {
    await ensureWorkflowConversation(env, channel, cuid, text);
    const wf = await getWorkflowConversation(env, channel, cuid);
    if (wf && ctx) ctx.waitUntil(pollAndRelayWorkflow(env, channel, cuid, wf.conversation_id));
    return;
  }
```
This needs `routeInbound` to accept `ctx?: ExecutionContext` and callers (`larkchannel.handleLarkWebhook`, `telegram` handler, both via `index.ts`) to thread `ctx` through. Add `ctx?: ExecutionContext` as a trailing optional param to `routeInbound`, `handleLarkWebhook`, and pass `ctx` from `index.ts` (it already has `ctx` in `fetch`). Import `getWorkflowConversation` + `pollAndRelayWorkflow` in `inbound.ts`.

- [ ] **Step 3: Typecheck, deploy, re-verify Step 7.**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run typecheck; $env:CLOUDFLARE_ACCOUNT_ID = "5f4d31a75fd669df8527210deb973591"; npx wrangler deploy`
Then repeat Task 4 Step 7's Lark test — Fin's answer should now relay via the poll.

- [ ] **Step 4: Commit.**

```bash
git add src/intercom.ts src/inbound.ts src/larkchannel.ts src/index.ts
git commit -m "feat(wf-bridge): poll fallback to relay Fin replies when no webhook fires"
```

---

## Task 5: End-to-end acceptance test (Lark)

**Files:** none (live test). Keep `wrangler tail` running to `wf_tail.log`.

- [ ] **Step 1: Fresh first message.** User DMs Lark bot **"how do I check my deposit?"**.
  Expected: a **new `IGaming Lark` conversation** in the Intercom inbox with **no external banner**; **Fin answers inside it**; the answer is **relayed to Lark**. (Confirm conversation id via `GET /conversations` if needed.)

- [ ] **Step 2: Follow-up message (build-time unknown #2).** Same user sends a 2nd question in Lark.
  Expected: **same** conversation (no new one); **Fin answers the follow-up**; relayed to Lark.
  If Fin does NOT answer follow-ups: note it; option is to resolve+recreate per message — record as a follow-up issue, do not block the POC.

- [ ] **Step 3: Human reply.** A teammate opens that `IGaming Lark` conversation in Intercom and types a reply.
  Expected: arrives in Lark prefixed `👤`. Send another Lark message → appears in the same conversation (author user, not echoed).

- [ ] **Step 4: Close.** Teammate closes the conversation.
  Expected: Lark gets "✅ This chat is closed…"; the next Lark message creates a **fresh** conversation and Fin answers again (Workflow re-triggers).

- [ ] **Step 5: Loop/echo check.** Review `wf_tail.log`: no duplicate relays (dedupe working), customer messages never relayed back, notes not relayed.

- [ ] **Step 6: Telegram still works.** Send the Telegram bot a question.
  Expected: unchanged (still the old path, since flag is `"lark"` only).

---

## Task 6: Docs + finalize

**Files:** Modify `README.md`

- [ ] **Step 1: Document the mode.** Add a short "Intercom Workflow Bridge" subsection to `README.md` (under or near "Human handoff"):

```markdown
## Intercom Workflow Bridge (INTERCOM_WORKFLOW_BRIDGE)
Set `INTERCOM_WORKFLOW_BRIDGE` (wrangler.toml `[vars]`) to `lark`, `telegram`, `lark,telegram`, or `all`
to make that channel's messages BECOME a normal Intercom conversation (Conversations API), where an
Intercom Workflow ("Customer sends their first message", audience `source_channel is <channel>`) lets
Fin answer in-thread and agents reply in the same thread. The Worker relays Fin (bot) + agent (admin)
replies back to the channel via /intercom/webhook (deduped). `false` = the Fin Agent API + mirror path.
Prereqs: a People text attribute `source_channel`, and the live Workflow described above.
```

- [ ] **Step 2: Commit.**

```bash
git add README.md
git commit -m "docs: Intercom Workflow Bridge mode + setup"
```

- [ ] **Step 3 (decision, not code): promote or keep scoped.** If the POC passes for Lark and you want Telegram too, add `source_channel is telegram` to the Workflow audience (or a second Workflow) and set `INTERCOM_WORKFLOW_BRIDGE = "lark,telegram"`, then deploy and re-run Task 5 for Telegram.

---

## Self-review notes (author)

- **Spec coverage:** contact+attributes (Task 2), create-not-Messages-API conversation (Task 2 uses `POST /conversations`), mapping both directions (Task 1), reply-not-new on later messages (Task 2 `ensureWorkflowConversation`), webhook relay of admin/operator/Fin + ignore customer + dedupe + close-clears-mapping (Task 4), flag + fallback kept (Task 0, branches), acceptance POC (Task 5). All covered.
- **Unknowns are explicit tasks:** webhook topic (Task 4 Step 7 + 4b), follow-up answers (Task 5 Step 2).
- **Type consistency:** `workflowBridge(env, channel)`, `WorkflowConversation{conversation_id,contact_id,updated_at}`, `get/set/clearWorkflowConversation(env,channel,cuid[,conversationId])`, `ensureWorkflowContact(env,channel,cuid)`, `ensureWorkflowConversation(env,channel,cuid,text)` used consistently across tasks.
- **No Messages API:** conversations are created with `POST /conversations` (`createConversation`), never `POST /messages` — required so the "first message" Workflow triggers.
