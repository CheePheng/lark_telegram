/**
 * Mock iGaming data for the demo. Shapes follow the field tables in the source
 * doc (KYC / deposit / withdrawal). These are the *internal* records and may
 * contain raw provider/risk codes; the gateway (gateway.ts) is responsible for
 * masking and mapping them to user-safe wording before anything leaves.
 *
 * PRODUCTION SWAP: replace these lookups with real read-only iGaming API calls
 * inside gateway.ts. The output contract (the normalized JSON returned to Fin)
 * stays the same, so Fin's Data Connectors / Procedures don't change.
 */

export interface KycCaseInternal {
  member_id: string;
  kyc_case_id: string;
  overall_status: "NOT_STARTED" | "UNDER_REVIEW" | "ACTION_REQUIRED" | "APPROVED" | "REJECTED";
  current_stage: "DOCUMENT" | "FACE" | "ADDRESS" | "MANUAL_REVIEW" | "DONE";
  internal_reason_code?: string; // raw code — never exposed
  required_action: "REUPLOAD_DOCUMENT" | "RETRY_FACE" | "UPLOAD_ADDRESS" | "WAIT" | "CONTACT_SUPPORT";
  resubmit_allowed: boolean;
  sla_breached: boolean;
  eta_at?: string;
}

export interface DepositInternal {
  member_id: string;
  deposit_id: string;
  amount: number;
  currency: string;
  payment_status: "CREATED" | "PENDING" | "AUTHORIZED" | "SETTLED" | "FAILED" | "CANCELLED" | "REVERSED";
  posting_status: "NOT_STARTED" | "PENDING" | "POSTED" | "FAILED" | "REVERSED";
  psp_gateway: string;
  internal_failure_code?: string; // raw code — never exposed
  sla_breached: boolean;
  eta_at?: string;
}

export interface WithdrawalInternal {
  member_id: string;
  withdrawal_id: string;
  amount: number;
  currency: string;
  status: "CREATED" | "UNDER_REVIEW" | "APPROVED" | "PROCESSING" | "SENDING" | "COMPLETED" | "FAILED" | "RETURNED";
  full_account: string; // full destination — must be masked before exposure
  psp_provider: string;
  requested_at: string;
  processed_at?: string;
  eta_at?: string;
  returned_to_wallet: boolean;
  resubmit_allowed: boolean;
  sla_breached: boolean;
  internal_failure_code?: string;
}

/** Members that "exist" in the demo. Used by the mock login + ownership checks. */
export const MOCK_MEMBERS: Array<{ member_id: string; brand_id: string; display_name: string }> = [
  { member_id: "300425", brand_id: "BRAND_A", display_name: "Demo Player A (300425)" },
  { member_id: "300999", brand_id: "BRAND_A", display_name: "Demo Player B (300999)" },
];

const KYC: Record<string, KycCaseInternal> = {
  "300425": {
    member_id: "300425",
    kyc_case_id: "KYC-260602-001",
    overall_status: "UNDER_REVIEW",
    current_stage: "DOCUMENT",
    required_action: "WAIT",
    resubmit_allowed: false,
    sla_breached: false,
    eta_at: "2026-06-04T00:00:00Z",
  },
  "300999": {
    member_id: "300999",
    kyc_case_id: "KYC-260610-014",
    overall_status: "ACTION_REQUIRED",
    current_stage: "MANUAL_REVIEW",
    internal_reason_code: "RISK_DOC_BLUR_LVL3",
    required_action: "REUPLOAD_DOCUMENT",
    resubmit_allowed: true,
    sla_breached: true,
  },
};

const DEPOSITS: Record<string, DepositInternal> = {
  "DEP-260603-001": {
    member_id: "300425",
    deposit_id: "DEP-260603-001",
    amount: 5000,
    currency: "USD",
    payment_status: "SETTLED",
    posting_status: "PENDING",
    psp_gateway: "DemoBankPay",
    sla_breached: false,
    eta_at: "2026-06-03T13:00:00Z",
  },
  "DEP-260605-014": {
    member_id: "300999",
    deposit_id: "DEP-260605-014",
    amount: 250,
    currency: "USD",
    payment_status: "SETTLED",
    posting_status: "PENDING",
    psp_gateway: "DemoWalletX",
    internal_failure_code: "POSTING_QUEUE_STUCK",
    sla_breached: true,
  },
};

const WITHDRAWALS: Record<string, WithdrawalInternal> = {
  "WD-260612-006": {
    member_id: "300425",
    withdrawal_id: "WD-260612-006",
    amount: 1000,
    currency: "USD",
    status: "PROCESSING",
    full_account: "6225 8801 2345 8821",
    psp_provider: "DemoPayout",
    requested_at: "2026-06-12T09:00:00Z",
    processed_at: "2026-06-12T11:30:00Z",
    eta_at: "2026-06-12T18:00:00Z",
    returned_to_wallet: false,
    resubmit_allowed: false,
    sla_breached: false,
  },
  "WD-260611-021": {
    member_id: "300999",
    withdrawal_id: "WD-260611-021",
    amount: 800,
    currency: "USD",
    status: "FAILED",
    full_account: "6225 8801 2345 4417",
    psp_provider: "DemoPayout",
    requested_at: "2026-06-11T08:00:00Z",
    processed_at: "2026-06-11T10:00:00Z",
    returned_to_wallet: true,
    resubmit_allowed: true,
    sla_breached: false,
    internal_failure_code: "PAYOUT_ACCOUNT_NAME_MISMATCH",
  },
};

export function findKyc(memberId: string): KycCaseInternal | null {
  return KYC[memberId] ?? null;
}
export function findDeposit(memberId: string, depositId: string): DepositInternal | null {
  const d = DEPOSITS[depositId];
  return d && d.member_id === memberId ? d : null;
}
export function findWithdrawal(memberId: string, withdrawalId: string): WithdrawalInternal | null {
  const w = WITHDRAWALS[withdrawalId];
  return w && w.member_id === memberId ? w : null;
}
export function isKnownMember(memberId: string): boolean {
  return MOCK_MEMBERS.some((m) => m.member_id === memberId);
}
export function brandFor(memberId: string): string | undefined {
  return MOCK_MEMBERS.find((m) => m.member_id === memberId)?.brand_id;
}
