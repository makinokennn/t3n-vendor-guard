/**
 * Small, dependency-free response validators.
 *
 * The contract is our own code, but the *response* arrives over a network from a
 * node. A response that is malformed, truncated, or hostile must never be
 * silently interpreted as a successful payment. Rather than trust the shape,
 * every response is narrowed here before anything acts on it.
 *
 * `assertShape`-style helpers are used instead of a schema library so the agent
 * keeps a zero-runtime-dependency surface: the only production dependency is the
 * T3N SDK itself.
 */

import type {
  CheckResult,
  Decision,
  PolicyResponse,
  PayoutResult,
  Reason,
} from "./types.ts";
import { VendorGuardError } from "./types.ts";

function fail(what: string, detail: string): never {
  throw new VendorGuardError("contract", `malformed ${what} from contract: ${detail}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string, field: string): string {
  if (typeof v !== "string") fail(what, `${field} must be a string, got ${typeof v}`);
  return v;
}

function num(v: unknown, what: string, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(what, `${field} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function bool(v: unknown, what: string, field: string): boolean {
  if (typeof v !== "boolean") fail(what, `${field} must be a boolean, got ${typeof v}`);
  return v;
}

function arr(v: unknown, what: string, field: string): unknown[] {
  if (!Array.isArray(v)) fail(what, `${field} must be an array, got ${typeof v}`);
  return v;
}

const DECISIONS: readonly string[] = ["allow", "review", "deny"];

function reasons(v: unknown, what: string): Reason[] {
  return arr(v, what, "reasons").map((r, i) => {
    if (!isObj(r)) fail(what, `reasons[${i}] is not an object`);
    return { code: str(r.code, what, `reasons[${i}].code`), detail: str(r.detail, what, `reasons[${i}].detail`) };
  });
}

export function validateCheckResult(raw: unknown): CheckResult {
  const what = "check-payout response";
  if (!isObj(raw)) fail(what, "expected an object");
  const decision = str(raw.decision, what, "decision");
  if (!DECISIONS.includes(decision)) {
    fail(what, `decision '${decision}' is not one of ${DECISIONS.join(", ")}`);
  }
  const policy = raw.policy_snapshot;
  if (!isObj(policy)) fail(what, "policy_snapshot missing");
  validatePolicyView(policy, what);
  return {
    decision: decision as Decision,
    reasons: reasons(raw.reasons ?? [], what),
    policy_snapshot: policy as unknown as CheckResult["policy_snapshot"],
    vendor_id: str(raw.vendor_id, what, "vendor_id"),
    amount: num(raw.amount, what, "amount"),
    currency: str(raw.currency, what, "currency"),
    daily_spent: num(raw.daily_spent, what, "daily_spent"),
  };
}

function validatePolicyView(p: Record<string, unknown>, what: string): void {
  num(p.max_single_payout, what, "policy.max_single_payout");
  num(p.max_daily_total, what, "policy.max_daily_total");
  num(p.require_memo_over, what, "policy.require_memo_over");
  arr(p.allowed_currencies, what, "policy.allowed_currencies");
  arr(p.blocked_countries, what, "policy.blocked_countries");
}

export function validatePolicyResponse(raw: unknown): PolicyResponse {
  const what = "get-policy response";
  if (!isObj(raw)) fail(what, "expected an object");
  const policy = raw.policy;
  if (!isObj(policy)) fail(what, "policy missing");
  validatePolicyView(policy, what);
  const vendors = arr(raw.vendors ?? [], what, "vendors").map((v, i) => {
    if (!isObj(v)) fail(what, `vendors[${i}] is not an object`);
    return {
      id: str(v.id, what, `vendors[${i}].id`),
      name: str(v.name, what, `vendors[${i}].name`),
      currency: str(v.currency, what, `vendors[${i}].currency`),
      country: str(v.country, what, `vendors[${i}].country`),
      active: bool(v.active, what, `vendors[${i}].active`),
      bank_last4: str(v.bank_last4, what, `vendors[${i}].bank_last4`),
    };
  });
  return {
    contract_version: str(raw.contract_version, what, "contract_version"),
    policy: policy as unknown as PolicyResponse["policy"],
    vendors,
    ignored_overrides: arr(raw.ignored_overrides ?? [], what, "ignored_overrides").map((x) =>
      str(x, what, "ignored_overrides[]"),
    ),
  };
}

const PAYOUT_STATUSES: readonly string[] = ["paid", "refused", "upstream_error"];

export function validatePayoutResult(raw: unknown): PayoutResult {
  const what = "payout response";
  if (!isObj(raw)) fail(what, "expected an object");
  const status = str(raw.status, what, "status");
  if (!PAYOUT_STATUSES.includes(status)) {
    fail(what, `status '${status}' is not one of ${PAYOUT_STATUSES.join(", ")}`);
  }
  // A `paid` result with no reference is not a payment we can reconcile, so we
  // refuse to call it one.
  if (status === "paid") {
    const ref = raw.reference;
    if (typeof ref !== "string" || ref.trim() === "") {
      fail(what, "status is 'paid' but no reference was returned — cannot reconcile this payment");
    }
  }
  return {
    status: status as PayoutResult["status"],
    id: typeof raw.id === "string" ? raw.id : undefined,
    reference: typeof raw.reference === "string" ? raw.reference : undefined,
    vendor_id: typeof raw.vendor_id === "string" ? raw.vendor_id : undefined,
    amount: typeof raw.amount === "number" ? raw.amount : undefined,
    currency: typeof raw.currency === "string" ? raw.currency : undefined,
    approval_ref: typeof raw.approval_ref === "string" ? raw.approval_ref : undefined,
    daily_total: typeof raw.daily_total === "number" ? raw.daily_total : undefined,
    review_flagged: typeof raw.review_flagged === "boolean" ? raw.review_flagged : undefined,
    reasons: raw.reasons === undefined ? undefined : reasons(raw.reasons, what),
    upstream_code: typeof raw.upstream_code === "number" ? raw.upstream_code : undefined,
  };
}
