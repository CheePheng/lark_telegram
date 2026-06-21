/**
 * Lark custom-bot webhook client: builds an interactive card from an exception
 * and posts it to a group chat. Mock-logs when LARK_WEBHOOK_URL is unset.
 * Signature: base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, msg = "")).
 */
import type { Env } from "./env";

export type ExceptionType =
  | "DEPOSIT_NOT_POSTED" | "DEPOSIT_DUPLICATE" | "DEPOSIT_AMOUNT_MISMATCH"
  | "WITHDRAWAL_STALLED" | "WITHDRAWAL_NOT_RETURNED" | "WITHDRAWAL_ACCOUNT_MISMATCH" | "WITHDRAWAL_REPEATED_FAILURE"
  | "KYC_SLA_BREACH" | "KYC_MANUAL_REVIEW" | "KYC_EXCESSIVE_RETRIES";

interface ExceptionMeta {
  team: string;
  priority: "Normal" | "High" | "Urgent";
  titlePrefix: string;
}

const EXCEPTION_META: Record<ExceptionType, ExceptionMeta> = {
  DEPOSIT_NOT_POSTED: { team: "WALLET_OPS", priority: "High", titlePrefix: "Deposit Delay" },
  DEPOSIT_DUPLICATE: { team: "WALLET_OPS", priority: "Urgent", titlePrefix: "Duplicate Charge" },
  DEPOSIT_AMOUNT_MISMATCH: { team: "WALLET_OPS", priority: "Urgent", titlePrefix: "Amount Mismatch" },
  WITHDRAWAL_STALLED: { team: "PAYOUT_OPS", priority: "High", titlePrefix: "Withdrawal Delay" },
  WITHDRAWAL_NOT_RETURNED: { team: "PAYOUT_OPS", priority: "Urgent", titlePrefix: "Funds Not Returned" },
  WITHDRAWAL_ACCOUNT_MISMATCH: { team: "RISK_OPS", priority: "Urgent", titlePrefix: "Payout Account Mismatch" },
  WITHDRAWAL_REPEATED_FAILURE: { team: "PAYOUT_OPS", priority: "High", titlePrefix: "Repeated Payout Failure" },
  KYC_SLA_BREACH: { team: "KYC_OPS", priority: "High", titlePrefix: "KYC SLA Breach" },
  KYC_MANUAL_REVIEW: { team: "COMPLIANCE_OPS", priority: "High", titlePrefix: "KYC Manual Review" },
  KYC_EXCESSIVE_RETRIES: { team: "KYC_OPS", priority: "High", titlePrefix: "KYC Excessive Retries" },
};

export function isExceptionType(s: string): s is ExceptionType {
  return Object.prototype.hasOwnProperty.call(EXCEPTION_META, s);
}

export interface LarkTaskInput {
  member_id: string;
  brand_id?: string;
  business_ref: string;
  exception_type: ExceptionType;
  summary?: string;
  source?: string;
  intercom_conversation_id?: string;
}

function field(label: string, value: string) {
  return { is_short: true, text: { tag: "lark_md", content: `**${label}**\n${value}` } };
}

function priorityColor(p: string): string {
  return p === "Urgent" ? "red" : p === "High" ? "orange" : "blue";
}

export function buildCard(input: LarkTaskInput): unknown {
  const meta = EXCEPTION_META[input.exception_type];
  const fields = [
    field("Member", input.brand_id ? `${input.member_id} / ${input.brand_id}` : input.member_id),
    field("Reference", input.business_ref),
    field("Priority", meta.priority),
    field("Owner team", meta.team),
    field("Source", input.source ?? "Telegram"),
    field("Status", "Open"),
  ];
  const elements: unknown[] = [{ tag: "div", fields }];
  if (input.summary) elements.push({ tag: "div", text: { tag: "lark_md", content: `**Issue:** ${input.summary}` } });
  if (input.intercom_conversation_id)
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**Intercom:** ${input.intercom_conversation_id}` } });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: `Created ${new Date().toISOString()}` }] });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: priorityColor(meta.priority),
      title: { tag: "plain_text", content: `[${meta.titlePrefix}] ${input.business_ref}` },
    },
    elements,
  };
}

/** Post a card to the Lark custom-bot webhook. Mock-logs if no URL is configured. */
export async function postLarkCard(env: Env, card: unknown): Promise<{ posted: boolean; mock: boolean }> {
  const url = env.LARK_WEBHOOK_URL;
  if (!url || url.includes("CHANGE_ME")) {
    console.log("LARK_MOCK " + JSON.stringify(card));
    return { posted: false, mock: true };
  }
  const body: Record<string, unknown> = { msg_type: "interactive", card };
  if (env.LARK_WEBHOOK_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = await larkSign(timestamp, env.LARK_WEBHOOK_SECRET);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const detail = await res.text().catch(() => "");
  const ok = res.ok && /"(StatusCode|code)"\s*:\s*0/.test(detail); // Lark returns code:0 on success
  if (!ok) console.error(`Lark post failed: ${res.status} ${detail}`);
  return { posted: ok, mock: false };
}

/** Lark custom-bot signature: base64(HMAC-SHA256(key = `${ts}\n${secret}`, msg = "")), ts in seconds. */
async function larkSign(timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}
