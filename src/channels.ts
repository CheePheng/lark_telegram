/**
 * Outbound dispatcher: send a text message to a customer on whichever channel
 * they came from. Keeps the rest of the bridge channel-agnostic.
 */
import type { Env } from "./env";
import type { Channel } from "./kv";
import { sendTelegramMessage, sendTelegramBrandSelection, sendTelegramPhoto, sendTelegramAnswer } from "./telegram";
import { sendLarkMessage, sendLarkBrandSelection, sendLarkImage, sendLarkAnswerCard } from "./larkchannel";
import { htmlToPlainText, extractImageUrls, parseFinAnswer } from "./html";

export async function sendToChannel(env: Env, channel: Channel, cuid: string, text: string): Promise<void> {
  if (channel === "telegram") return sendTelegramMessage(env, cuid, text);
  return sendLarkMessage(env, cuid, text);
}

/** Relay an image (by URL) to the customer's channel. */
export async function sendImageToChannel(env: Env, channel: Channel, cuid: string, url: string): Promise<void> {
  if (channel === "telegram") return sendTelegramPhoto(env, cuid, url);
  return sendLarkImage(env, cuid, url);
}

/**
 * Relay one Fin/agent answer part (HTML) to the customer's channel.
 * - Lark + a Fin (bot) answer that has image(s)  -> ONE interactive card (title/text/image/source).
 * - Everything else (Telegram, human replies, or no images) -> plain text, images as separate messages.
 * `prefix` is "👤 " for a human agent reply, "" for Fin.
 */
export async function relayAnswerPart(
  env: Env,
  channel: Channel,
  cuid: string,
  prefix: string,
  body: string,
): Promise<void> {
  const images = extractImageUrls(body);
  const hasLinks = /<a\b[^>]*href=/i.test(body);
  if (prefix === "" && (images.length > 0 || hasLinks)) {
    // Fin (bot) answer with image(s) or links: one combined, clean message per channel.
    const answer = parseFinAnswer(body);
    if (channel === "lark") return sendLarkAnswerCard(env, cuid, answer); // interactive card (lark_md links)
    return sendTelegramAnswer(env, cuid, answer); // photo/album + caption, or text + sources
  }
  await sendToChannel(env, channel, cuid, `${prefix}${htmlToPlainText(body)}`);
  for (const url of images) await sendImageToChannel(env, channel, cuid, url).catch(() => {});
}

/** Show the brand-selection buttons on the customer's channel. */
export async function sendBrandSelection(env: Env, channel: Channel, cuid: string): Promise<void> {
  if (channel === "telegram") return sendTelegramBrandSelection(env, cuid);
  return sendLarkBrandSelection(env, cuid);
}
