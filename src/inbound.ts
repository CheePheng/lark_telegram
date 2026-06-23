/**
 * Channel-agnostic inbound routing. One customer message comes in (from Telegram
 * or Lark); if a human handoff is open we relay it into the Intercom conversation,
 * otherwise we forward it to Fin. Fin's answer returns asynchronously via
 * /fin/webhook and is sent back on the originating channel.
 */
import type { Env } from "./env";
import { workflowBridge } from "./env";
import type { Channel } from "./kv";
import { getHandoff, getFinConversation, linkFinConversation, appendTranscript } from "./kv";
import { sendToFin, type FinUserContext } from "./fin";
import { mirrorCustomerToIntercom, ensureWorkflowConversation } from "./intercom";

/** Friendly display name shown on the Intercom contact/conversation per channel. */
const DISPLAY_NAME: Record<Channel, string> = {
  telegram: "IGaming Telegram",
  lark: "IGaming Lark",
};

/** Route one inbound customer message: live human handoff if open, else Fin. */
export async function routeInbound(env: Env, channel: Channel, cuid: string, text: string, language?: string): Promise<void> {
  // Workflow Bridge: the message IS the Intercom conversation; an Intercom Workflow
  // + Fin answer inside it, and /intercom/webhook relays replies back. No Fin Agent API.
  if (workflowBridge(env, channel)) {
    await ensureWorkflowConversation(env, channel, cuid, text);
    return;
  }

  // --- canonical-mirror path (flag off) ---
  // Mirror EVERY customer message into the canonical "IGaming <Channel>" conversation
  // (posted as the contact, so it never triggers /intercom/webhook — no echo). In handoff
  // mode this is how the agent sees the customer; in AI mode it keeps the agent's context full.
  await mirrorCustomerToIntercom(env, channel, cuid, text);

  const handoff = await getHandoff(env, channel, cuid);
  if (handoff?.state === "open") return; // a human is handling -> do not also send to Fin

  await forwardToFin(env, channel, cuid, text, language);
}

async function forwardToFin(env: Env, channel: Channel, cuid: string, text: string, language?: string): Promise<void> {
  await appendTranscript(env, channel, cuid, "customer", text);

  const finCtx: FinUserContext = {
    channel,
    userId: cuid,
    displayName: DISPLAY_NAME[channel],
    language,
    verified: true,
  };

  const conversationId = await getFinConversation(env, channel, cuid);
  const { conversationId: newId } = await sendToFin(env, finCtx, text, conversationId);
  if (newId !== conversationId) await linkFinConversation(env, channel, cuid, newId);
}
