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
  brandFor,
  type KycCaseInternal,
  type DepositInternal,
  type WithdrawalInternal,
} from "./mockdata";
import { buildCard, postLarkCard, type ExceptionType } from "./lark";
import { alreadyEscalatedToLark } from "./kv";

export function isGatewayPath(pathname: string): boolean {
  return pathname === "/api/kyc" || pathname === "/api/deposit" || pathname === "/api/withdrawal";
}

export async function handleGateway(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  const memberId = url.searchParams.get("member_id")?.trim() ?? "";
  if (!memberId) return json({ error: "member_id_required" }, 400);

  switch (url.pathname) {
    case "/api/kyc": {
      const k = findKyc(memberId);
      if (k) await maybeEscalate(env, "kyc", memberId, k);
      return json(kycOut(k));
    }
    case "/api/deposit": {
      const d = findDeposit(memberId, url.searchParams.get("deposit_id")?.trim() ?? "");
      if (d) await maybeEscalate(env, "deposit", memberId, d);
      return json(depositOut(d));
    }
    case "/api/withdrawal": {
      const w = findWithdrawal(memberId, url.searchParams.get("withdrawal_id")?.trim() ?? "");
      if (w) await maybeEscalate(env, "withdrawal", memberId, w);
      return json(withdrawalOut(w));
    }
    default:
      return json({ error: "not_found" }, 404);
  }
}

// --- auto-escalation: fire a Lark card when a looked-up case is an exception -

type CaseKind = "kyc" | "deposit" | "withdrawal";
type InternalRecord = KycCaseInternal | DepositInternal | WithdrawalInternal;

async function maybeEscalate(env: Env, kind: CaseKind, memberId: string, rec: InternalRecord): Promise<void> {
  const ex = detectException(kind, rec);
  if (!ex) return;
  if (await alreadyEscalatedToLark(env, `${ex.business_ref}:${ex.exception_type}`)) return;
  await postLarkCard(
    env,
    buildCard({
      member_id: memberId,
      brand_id: brandFor(memberId),
      business_ref: ex.business_ref,
      exception_type: ex.exception_type,
      summary: ex.summary,
      source: "Telegram",
    }),
  );
}

function detectException(
  kind: CaseKind,
  rec: InternalRecord,
): { business_ref: string; exception_type: ExceptionType; summary: string } | null {
  if (kind === "deposit") {
    const d = rec as DepositInternal;
    if (d.sla_breached || d.posting_status === "FAILED") {
      return { business_ref: d.deposit_id, exception_type: "DEPOSIT_NOT_POSTED", summary: "Paid but not posted to wallet beyond threshold." };
    }
    return null;
  }
  if (kind === "withdrawal") {
    const w = rec as WithdrawalInternal;
    if (w.internal_failure_code && /MISMATCH/i.test(w.internal_failure_code)) {
      return { business_ref: w.withdrawal_id, exception_type: "WITHDRAWAL_ACCOUNT_MISMATCH", summary: "Payout account / name mismatch." };
    }
    if (w.status === "FAILED" && !w.returned_to_wallet) {
      return { business_ref: w.withdrawal_id, exception_type: "WITHDRAWAL_NOT_RETURNED", summary: "Failed withdrawal; funds not returned to wallet." };
    }
    if (w.sla_breached) {
      return { business_ref: w.withdrawal_id, exception_type: "WITHDRAWAL_STALLED", summary: "Withdrawal stalled beyond SLA." };
    }
    return null;
  }
  const k = rec as KycCaseInternal;
  if (k.sla_breached) {
    return { business_ref: k.kyc_case_id, exception_type: "KYC_SLA_BREACH", summary: "KYC review past its SLA." };
  }
  if (k.current_stage === "MANUAL_REVIEW") {
    return { business_ref: k.kyc_case_id, exception_type: "KYC_MANUAL_REVIEW", summary: "KYC requires manual review." };
  }
  return null;
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
