/**
 * Bindings available to the Worker at runtime.
 * - KV namespace + non-secret vars are declared in wrangler.toml.
 * - Secrets are injected via `wrangler secret put NAME` (or .dev.vars locally).
 */
import type { Channel } from "./kv";

export interface Env {
  // KV
  TG_FIN_STATE: KVNamespace;

  // Public vars (wrangler.toml [vars])
  INTERCOM_BASE_URL: string;
  INTERCOM_API_VERSION: string;
  PUBLIC_BASE_URL: string;
  ALLOW_UNVERIFIED_CHAT: string; // "true" | "false"
  INTERCOM_WORKFLOW_BRIDGE: string; // "false" | "lark" | "telegram" | "lark,telegram" | "all"

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERCOM_FIN_API_KEY: string;
  INTERCOM_FIN_WEBHOOK_SECRET: string;
  GATEWAY_API_TOKEN: string;
  IDENTITY_SIGNING_SECRET: string;
  INTERCOM_API_TOKEN: string;
  INTERCOM_CLIENT_SECRET: string;
  LARK_WEBHOOK_URL: string;
  LARK_WEBHOOK_SECRET: string;

  // Lark custom app (customer channel)
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

export function allowUnverifiedChat(env: Env): boolean {
  return (env.ALLOW_UNVERIFIED_CHAT ?? "true").toLowerCase() !== "false";
}

/** True if the Intercom Workflow Bridge is enabled for this channel. */
export function workflowBridge(env: Env, channel: Channel): boolean {
  const v = (env.INTERCOM_WORKFLOW_BRIDGE ?? "false").toLowerCase().trim();
  if (v === "true" || v === "all") return true;
  return v.split(",").map((s) => s.trim()).includes(channel);
}
