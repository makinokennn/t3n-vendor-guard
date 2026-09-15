import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCheckResult,
  validatePayoutResult,
  validatePolicyResponse,
} from "../src/validate.ts";
import { VendorGuardError } from "../src/types.ts";

const POLICY = {
  max_single_payout: 50_000,
  max_daily_total: 200_000,
  allowed_currencies: ["USD"],
  require_memo_over: 10_000,
  blocked_countries: [],
};

test("a well-formed check result passes through", () => {
  const r = validateCheckResult({
    decision: "allow",
    reasons: [],
    policy_snapshot: POLICY,
    vendor_id: "v",
    amount: 1,
    currency: "USD",
    daily_spent: 0,
  });
  assert.equal(r.decision, "allow");
});

test("an unknown decision is rejected rather than treated as allow", () => {
  assert.throws(
    () =>
      validateCheckResult({
        decision: "permit",
        reasons: [],
        policy_snapshot: POLICY,
        vendor_id: "v",
        amount: 1,
        currency: "USD",
        daily_spent: 0,
      }),
    /not one of allow, review, deny/,
  );
});

test("a missing decision is rejected", () => {
  assert.throws(() => validateCheckResult({ reasons: [] }), /decision must be a string/);
});

test("a payout claiming success without a reference is refused", () => {
  assert.throws(
    () => validatePayoutResult({ status: "paid" }),
    /cannot reconcile this payment/,
  );
});

test("an unknown payout status is rejected", () => {
  assert.throws(() => validatePayoutResult({ status: "probably_fine" }), /not one of/);
});

test("a valid paid result is accepted", () => {
  const r = validatePayoutResult({ status: "paid", reference: "BANK-1", amount: 10 });
  assert.equal(r.status, "paid");
  assert.equal(r.reference, "BANK-1");
});

test("reason codes must carry both a code and a detail", () => {
  assert.throws(
    () => validatePayoutResult({ status: "refused", reasons: [{ code: "x" }] }),
    /reasons\[0\]\.detail must be a string/,
  );
});

test("policy responses are validated field by field", () => {
  assert.throws(() => validatePolicyResponse({ contract_version: "0.1.0" }), /policy missing/);
  const ok = validatePolicyResponse({
    contract_version: "0.1.0",
    policy: POLICY,
    vendors: [],
    ignored_overrides: [],
  });
  assert.equal(ok.policy.max_single_payout, 50_000);
});

test("a non-numeric policy limit is rejected", () => {
  assert.throws(
    () =>
      validatePolicyResponse({
        contract_version: "0.1.0",
        policy: { ...POLICY, max_single_payout: "50000" },
        vendors: [],
      }),
    /max_single_payout must be a finite number/,
  );
});

test("validation failures are typed as contract errors", () => {
  try {
    validatePayoutResult(null);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VendorGuardError);
    assert.equal(e.kind, "contract");
  }
});
