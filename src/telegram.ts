/**
 * Telegram bridge: receives Bot API webhook updates, forwards user messages to
 * Fin, and exposes sendTelegramMessage (used here and by the Fin callback).
 *
 * Assumes 1:1 private chats, so chat.id === from.id and a single id identifies
 * both the user (for identity/KV) and the chat (for sending).
 */
import type { Env } from "./env";
import { allowUnverifiedChat } from "./env";
import { getMapping, putMapping, getConversationId, linkConversation, clearConversation, getHandoff, clearHandoff, appendTranscript, clearTranscript } from "./kv";
import { sendToFin, type FinUserContext } from "./fin";
import { buildVerifyLink } from "./identity";
import { replyAsUser } from "./intercom";

interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  message_id: number;
  from?: { id: number; language_code?: string };
  chat: { id: number };
  text?: string;
}

const TG_MAX_LEN = 4000;

/** True only if the request carries the secret we registered with setWebhook. */
export function verifyTelegramSecret(request: Request, env: Env): boolean {
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TELEGRAM_WEBHOOK_SECRET;
}

export async function sendTelegramMessage(env: Env, chatId: string | number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.length > TG_MAX_LEN ? text.slice(0, TG_MAX_LEN) + "…" : text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`Telegram sendMessage failed: ${res.status} ${detail}`);
  }
}

async function sendTyping(env: Env, chatId: string | number): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!verifyTelegramSecret(request, env)) return new Response("unauthorized", { status: 401 });

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const msg = update?.message ?? update?.edited_message;
  const text = msg?.text?.trim();
  if (!msg || !text) return ok(); // ignore non-text updates

  const tgUserId = String(msg.from?.id ?? msg.chat.id);
  const langCode = msg.from?.language_code;

  try {
    if (text.startsWith("/start")) {
      await sendTelegramMessage(env, tgUserId, startMessage());
      return ok();
    }
    if (text.startsWith("/verify")) {
      const link = await buildVerifyLink(env, tgUserId);
      await sendTelegramMessage(env, tgUserId, `To view your account data, verify here:\n${link}`);
      return ok();
    }
    if (text.startsWith("/reset") || text.startsWith("/new") || text.startsWith("/clear")) {
      const handoff = await getHandoff(env, tgUserId);
      if (handoff?.state === "open") await clearHandoff(env, tgUserId, handoff.conversation_id);
      const convId = await getConversationId(env, tgUserId);
      if (convId) await clearConversation(env, tgUserId, convId);
      await clearTranscript(env, tgUserId);
      await sendTelegramMessage(env, tgUserId, "🔄 Fresh start — cleared our conversation (and any human chat). Ask me anything.");
      return ok();
    }

    // If the player is in a human handoff, route their message to the inbox conversation.
    const handoff = await getHandoff(env, tgUserId);
    if (handoff?.state === "open") {
      await replyAsUser(env, handoff.conversation_id, handoff.contact_id, text);
      return ok();
    }

    await forwardToFin(env, tgUserId, text, langCode);
  } catch (err) {
    console.error("telegram handler error", err);
    await sendTelegramMessage(env, tgUserId, "Sorry — something went wrong. Please try again in a moment.").catch(() => {});
  }
  return ok();
}

async function forwardToFin(env: Env, tgUserId: string, text: string, langCode?: string): Promise<void> {
  const mapping = await getMapping(env, tgUserId);
  const verified = mapping?.verified === true;

  // Persist the detected language on first contact so Fin/templates can use it.
  if (!mapping || (langCode && mapping.language !== langCode)) {
    await putMapping(env, {
      telegram_user_id: tgUserId,
      member_id: mapping?.member_id,
      brand_id: mapping?.brand_id,
      intercom_contact_id: mapping?.intercom_contact_id,
      verified: verified,
      verification_method: mapping?.verification_method,
      language: langCode ?? mapping?.language,
      updated_at: new Date().toISOString(),
    });
  }

  if (!verified && !allowUnverifiedChat(env)) {
    const link = await buildVerifyLink(env, tgUserId);
    await sendTelegramMessage(env, tgUserId, `Please verify your account first:\n${link}`);
    return;
  }

  await sendTyping(env, tgUserId);
  await appendTranscript(env, tgUserId, "customer", text);

  const finCtx: FinUserContext = {
    userId: tgUserId,
    displayName: "IGaming Telegram",
    memberId: mapping?.member_id,
    brandId: mapping?.brand_id,
    language: langCode ?? mapping?.language,
    verified,
  };

  const conversationId = await getConversationId(env, tgUserId);
  const { conversationId: newId } = await sendToFin(env, finCtx, text, conversationId);
  if (newId !== conversationId) await linkConversation(env, tgUserId, newId);
  // Fin's actual answer arrives asynchronously via /fin/webhook -> sendTelegramMessage.
}

function startMessage(): string {
  return [
    "👋 Welcome! I can help with KYC, deposits, withdrawals, and general questions.",
    "",
    "To see your own account details, type /verify to securely link your account.",
    "Type /reset anytime to start a fresh conversation.",
    "Otherwise, just ask me a question.",
  ].join("\n");
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}
