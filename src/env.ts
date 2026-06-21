/**
 * Bindings available to the Worker at runtime.
 * - KV namespace + non-secret vars are declared in wrangler.toml.
 * - Secrets are injected via `wrangler secret put NAME` (or .dev.vars locally).
 */
export interface Env {
  // KV
  TG_FIN_STATE: KVNamespace;

  // Public vars (wrangler.toml [vars])
  INTERCOM_BASE_URL: string;
  INTERCOM_API_VERSION: string;
  PUBLIC_BASE_URL: string;
  ALLOW_UNVERIFIED_CHAT: string; // "true" | "false"

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERCOM_FIN_API_KEY: string;
  INTERCOM_FIN_WEBHOOK_SECRET: string;
  GATEWAY_API_TOKEN: string;
  IDENTITY_SIGNING_SECRET: string;
  INTERCOM_API_TOKEN: string;
  INTERCOM_CLIENT_SECRET: string;
}

export function allowUnverifiedChat(env: Env): boolean {
  return (env.ALLOW_UNVERIFIED_CHAT ?? "true").toLowerCase() !== "false";
}
