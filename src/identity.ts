/**
 * Identity verification — the doc's rule: never trust a Telegram username alone
 * before showing account data.
 *
 * DEMO: the "login" is a mock page that lets you pick a demo member. The token
 * signing + KV mapping below are REAL so they survive to production.
 * PRODUCTION SWAP: replace the mock page with your real iGaming login. After
 * login, the iGaming site issues a signed token; point its redirect at
 * /verify/complete and verify the token here instead of trusting the form.
 *
 *   GET  /verify?state=...     -> mock login page (choose a member)
 *   POST /verify/complete      -> writes the verified Telegram<->member mapping
 */
import type { Env } from "./env";
import { putMapping, consumeVerifyState, putVerifyState, getMapping } from "./kv";
import { MOCK_MEMBERS, isKnownMember, brandFor } from "./mockdata";
import { base64urlEncode, hmacSha256Hex } from "./crypto";
import { sendTelegramMessage } from "./telegram";

/** Create a one-time verification link for a Telegram user. */
export async function buildVerifyLink(env: Env, tgUserId: string): Promise<string> {
  const state = crypto.randomUUID();
  await putVerifyState(env, state, tgUserId);
  return `${env.PUBLIC_BASE_URL}/verify?state=${encodeURIComponent(state)}`;
}

/** A signed token binding a Telegram user to a member id (prod-ready mechanic). */
export async function issueIdentityToken(env: Env, tgUserId: string, memberId: string): Promise<string> {
  const payload = base64urlEncode(JSON.stringify({ sub: tgUserId, member_id: memberId, iat: Date.now() }));
  const sig = await hmacSha256Hex(env.IDENTITY_SIGNING_SECRET, payload);
  return `${payload}.${sig}`;
}

export function handleVerifyPage(url: URL): Response {
  const state = url.searchParams.get("state") ?? "";
  if (!state) return html(page("Invalid link", "<p>This verification link is missing its state.</p>"), 400);

  const options = MOCK_MEMBERS.map(
    (m) => `<label class="opt"><input type="radio" name="member_id" value="${m.member_id}" required> ${escapeHtml(m.display_name)}</label>`,
  ).join("");

  const body = `
    <p>This is a <strong>demo</strong> stand-in for logging into the iGaming site.
    Pick which player you are to link this Telegram chat to that account.</p>
    <form method="POST" action="/verify/complete">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <div class="opts">${options}</div>
      <button type="submit">Verify &amp; link my account</button>
    </form>`;
  return html(page("Verify your account", body));
}

export async function handleVerifyComplete(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return html(page("Error", "<p>Method not allowed.</p>"), 405);

  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const memberId = String(form.get("member_id") ?? "");

  const tgUserId = state ? await consumeVerifyState(env, state) : null;
  if (!tgUserId) return html(page("Link expired", "<p>This verification link is invalid or has expired. Please request a new one from the bot.</p>"), 400);
  if (!isKnownMember(memberId)) return html(page("Unknown member", "<p>That member could not be found.</p>"), 400);

  const existing = await getMapping(env, tgUserId);
  await putMapping(env, {
    telegram_user_id: tgUserId,
    member_id: memberId,
    brand_id: brandFor(memberId),
    intercom_contact_id: existing?.intercom_contact_id,
    verified: true,
    verification_method: "SIGNED_LOGIN_TOKEN",
    language: existing?.language,
    updated_at: new Date().toISOString(),
  });

  // Issue the signed token (prod mechanic; stored implicitly via the mapping).
  await issueIdentityToken(env, tgUserId, memberId);

  // Let the user know in Telegram that they're verified (best-effort).
  ctx.waitUntil(
    sendTelegramMessage(env, tgUserId, "✅ You're verified. You can now ask about your KYC, deposits, and withdrawals.").catch(() => {}),
  );

  return html(page("Verified", `<p>✅ Your account is linked. You can return to Telegram and continue the chat.</p>`));
}

// --- tiny HTML rendering ---------------------------------------------------

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1c1c1e}
  h1{font-size:20px} .opts{display:flex;flex-direction:column;gap:10px;margin:16px 0}
  .opt{padding:12px;border:1px solid #ddd;border-radius:10px;cursor:pointer}
  button{padding:12px 16px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}
  .note{color:#666;font-size:13px;margin-top:24px}
</style></head><body>
  <h1>${escapeHtml(title)}</h1>
  ${inner}
  <p class="note">Demo verification. In production this screen is your real iGaming login.</p>
</body></html>`;
}

function html(s: string, status = 200): Response {
  return new Response(s, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}
