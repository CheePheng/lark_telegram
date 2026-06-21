/**
 * iGaming data gateway: the read-only endpoints Fin's Data Connectors call.
 *   GET /api/kyc?member_id=...
 *   GET /api/deposit?member_id=...&deposit_id=...
 *   GET /api/withdrawal?member_id=...&withdrawal_id=...
 *
 * Responsibilities (per doc §11): authenticate the caller, enforce data
 * minimization, MASK sensitive fields, and map raw provider/risk codes to
 * approved user-safe wording. Never returns internal codes or scores.
 */
import type { Env } from "./env";
import { safeEqual } from "./crypto";
import {
  findKyc,
  findDeposit,
  findWithdrawal,
  type KycCaseInternal,
  type DepositInternal,
  type WithdrawalInternal,
} from "./mockdata";

export function isGatewayPath(pathname: string): boolean {
  return pathname === "/api/kyc" || pathname === "/api/deposit" || pathname === "/api/withdrawal";
}

export async function handleGateway(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const memberId = url.searchParams.get("member_id")?.trim() ?? "";
  if (!memberId) return json({ error: "member_id_required" }, 400);

  switch (url.pathname) {
    case "/api/kyc":
      return json(kycOut(findKyc(memberId)));
    case "/api/deposit":
      return json(depositOut(findDeposit(memberId, url.searchParams.get("deposit_id")?.trim() ?? "")));
    case "/api/withdrawal":
      return json(withdrawalOut(findWithdrawal(memberId, url.searchParams.get("withdrawal_id")?.trim() ?? "")));
    default:
      return json({ error: "not_found" }, 404);
  }
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  return token.length > 0 && safeEqual(token, env.GATEWAY_API_TOKEN);
}

// --- normalization (internal record -> user-safe JSON) ---------------------

function kycOut(k: KycCaseInternal | null) {
  if (!k) return { found: false };
  return {
    found: true,
    kyc_case_id: k.kyc_case_id,
    overall_status: k.overall_status,
    current_stage: k.current_stage,
    user_safe_reason: kycSafeReason(k),
    required_action: k.required_action,
    resubmit_allowed: k.resubmit_allowed,
    sla_breached: k.sla_breached,
    eta_at: k.eta_at ?? null,
  };
}

function depositOut(d: DepositInternal | null) {
  if (!d) return { found: false };
  return {
    found: true,
    deposit_id: d.deposit_id,
    amount: d.amount,
    currency: d.currency,
    payment_status: d.payment_status,
    posting_status: d.posting_status,
    failure_reason: depositSafeReason(d),
    progress_notes: depositProgressNote(d),
    eta_at: d.eta_at ?? null,
    sla_breached: d.sla_breached,
  };
}

function withdrawalOut(w: WithdrawalInternal | null) {
  if (!w) return { found: false };
  return {
    found: true,
    withdrawal_id: w.withdrawal_id,
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    masked_account: maskAccount(w.full_account),
    failure_reason: withdrawalSafeReason(w),
    requested_at: w.requested_at,
    processed_at: w.processed_at ?? null,
    eta_at: w.eta_at ?? null,
    returned_to_wallet: w.returned_to_wallet,
    resubmit_allowed: w.resubmit_allowed,
    sla_breached: w.sla_breached,
  };
}

// --- safe-reason layer: raw codes -> approved customer-facing wording -------

function kycSafeReason(k: KycCaseInternal): string {
  switch (k.required_action) {
    case "REUPLOAD_DOCUMENT":
      return "Your document could not be clearly verified. Please upload a clearer photo.";
    case "RETRY_FACE":
      return "The face check did not complete. Please retry the selfie step.";
    case "UPLOAD_ADDRESS":
      return "A proof-of-address document is still required.";
    case "CONTACT_SUPPORT":
      return "This case needs a manual review by our team.";
    case "WAIT":
    default:
      return "Your verification is in progress; no action is required right now.";
  }
}

function depositSafeReason(d: DepositInternal): string | null {
  if (d.payment_status === "FAILED") return "The payment was not completed by the provider.";
  if (d.posting_status === "FAILED") return "The deposit could not be posted to your wallet automatically.";
  return null; // nothing to disclose
}

function depositProgressNote(d: DepositInternal): string {
  if (d.payment_status === "PENDING") return "Payment confirmation is still in progress.";
  if (d.payment_status === "SETTLED" && d.posting_status === "PENDING")
    return "Payment confirmed; wallet posting is in progress.";
  if (d.posting_status === "POSTED") return "Funds have been posted to your wallet.";
  return "We are reviewing the current status of this deposit.";
}

function withdrawalSafeReason(w: WithdrawalInternal): string | null {
  if (w.status === "FAILED") {
    return w.returned_to_wallet
      ? "The withdrawal could not be completed and the funds were returned to your wallet."
      : "The withdrawal could not be completed. Our team is reviewing it.";
  }
  return null;
}

// --- masking ---------------------------------------------------------------

/** Keep only the last 4 visible digits: "**** 8821". */
function maskAccount(account: string): string {
  const digits = account.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
