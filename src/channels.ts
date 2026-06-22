/**
 * Outbound dispatcher: send a text message to a customer on whichever channel
 * they came from. Keeps the rest of the bridge channel-agnostic.
 */
import type { Env } from "./env";
import type { Channel } from "./kv";
import { sendTelegramMessage } from "./telegram";
import { sendLarkMessage } from "./larkchannel";

export async function sendToChannel(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  if (channel === "telegram") return sendTelegramMessage(env, cuid, text);
  return sendLarkMessage(env, cuid, text);
}
