/**
 * Shared types for vendor-guard.
 *
 * Deliberately no `enum`: this package runs directly on Node's type-stripping
 * loader (`node --test`), which erases types but does not transpile enums. Union
 * types of string literals give the same safety and actually exist at runtime
 * when you need to validate an untrusted string.
 */

/** The contract's decision for one payout intent. */
export type Decision = "allow" | "review" | "deny";

/** Every reason code the contract can return. Kept as a union so a `switch`
 *  over a code is exhaustively checked. */
export type ReasonCode =
  | "vendor_unknown"
  | "vendor_inactive"
  | "vendor_country_blocked"
  | "currency_mismatch"
  | "currency_not_allowed"
  | "amount_zero"
  | "amount_exceeds_single_cap"
  | "daily_cap_exceeded"
  | "memo_required"
  | "near_single_cap"
  | "near_daily_cap";

export interface Reason {
  code: ReasonCode | string;
  detail: string;
}

export interface PolicyView {
  max_single_payout: number;
  max_daily_total: number;
  allowed_currencies: string[];
  require_memo_over: number;
  blocked_countries: string[];
}

export interface VendorView {
  id: string;
  name: string;
  currency: string;
  country: string;
  active: boolean;
  bank_last4: string;
}

export interface PolicyResponse {
  contract_version: string;
  policy: PolicyView;
  vendors: VendorView[];
  /** Overrides the contract refused to apply because they would have loosened a
   *  limit. Non-empty here means someone tried to widen the policy. */
  ignored_overrides: string[];
}

/** Amounts are minor units (integer cents). Never floats. */
export interface PayoutIntent {
  vendorId: string;
  amount: number;
  currency: string;
  memo?: string;
}

export interface CheckResult {
  decision: Decision;
  reasons: Reason[];
  policy_snapshot: PolicyView;
  vendor_id: string;
  amount: number;
  currency: string;
  daily_spent: number;
}

export interface PayoutResult {
  status: "paid" | "refused" | "upstream_error";
  id?: string;
  reference?: string;
  vendor_id?: string;
  amount?: number;
  currency?: string;
  approval_ref?: string;
  daily_total?: number;
  review_flagged?: boolean;
  reasons?: Reason[];
  upstream_code?: number;
}

/** The narrow slice of the T3N SDK this package actually needs.
 *
 *  Depending on an interface rather than on `T3nClient` directly is what makes
 *  the whole agent unit-testable with no network, no TEE and no credentials —
 *  the tests inject a fake that replays recorded contract responses. */
export interface ContractInvoker {
  invoke<T>(functionName: string, input: unknown): Promise<T>;
}

/** One line of the audit log. */
export type AuditEvent =
  | "check"
  | "refused"
  | "approval_rejected"
  | "paid"
  | "upstream_error"
  | "transport_error";

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  intent?: { vendorId: string; amount: number; currency: string; memo?: string };
  decision?: string;
  reasons?: { code: string; detail: string }[];
  reference?: string;
  approver?: string;
  nonce?: string;
  detail?: string;
}

export interface AgentConfig {
  /** Vendor-guard contract tail (without the `z:<tid>:` prefix). */
  contractTail: string;
  /** Tenant DID, e.g. `did:t3n:<hex>`. */
  tenantDid: string;
  /** Human approver's HMAC secret, used to verify approval tokens. */
  approvalSecret: string;
  /** Where the append-only audit log is written. */
  auditPath: string;
  /** Max approval-token lifetime accepted, in seconds. */
  maxApprovalTtlSecs: number;
  /** Allow the agent to proceed when policy says `review`? Default false. */
  allowReview: boolean;
}

/** A structured error carrying the contract's reason codes, so callers can
 *  branch on *why* something failed instead of string-matching a message. */
export class VendorGuardError extends Error {
  readonly reasons: Reason[];
  readonly kind: "config" | "contract" | "policy" | "approval" | "transport";

  constructor(
    kind: VendorGuardError["kind"],
    message: string,
    reasons: Reason[] = [],
  ) {
    super(message);
    this.name = "VendorGuardError";
    this.kind = kind;
    this.reasons = reasons;
  }
}
