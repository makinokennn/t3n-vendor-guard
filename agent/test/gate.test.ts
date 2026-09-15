import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaymentGate } from "../src/gate.ts";
import { AuditLog } from "../src/audit.ts";
import { mintApproval } from "../src/approval.ts";
import type { AgentConfig, ContractInvoker, PayoutIntent } from "../src/types.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const TENANT_DID = "did:t3n:abcdef0123456789abcdef0123456789abcdef01";

const POLICY_SNAPSHOT = {
  max_single_payout: 50_000,
  max_daily_total: 200_000,
  allowed_currencies: ["USD", "EUR"],
  require_memo_over: 10_000,
  blocked_countries: ["XX"],
};

/** A fake contract that replays scripted responses and records every call. */
class FakeContract implements ContractInvoker {
  readonly calls: { fn: string; input: unknown }[] = [];
  #script: Record<string, (input: WireIntent) => unknown>;

  constructor(script: Record<string, (input: WireIntent) => unknown>) {
    this.#script = script;
  }

  async invoke<T>(functionName: string, input: unknown): Promise<T> {
    this.calls.push({ fn: functionName, input });
    const handler = this.#script[functionName];
    if (!handler) throw new Error(`unexpected contract call: ${functionName}`);
    return handler(input as WireIntent) as T;
  }

  callsTo(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
}

/** The wire shape the contract receives (snake_case, per the WIT/JSON boundary). */
interface WireIntent {
  vendor_id: string;
  amount: number;
  currency: string;
  memo?: string;
}

function allowedCheck(intent: WireIntent) {
  return {
    decision: "allow" as const,
    reasons: [],
    policy_snapshot: POLICY_SNAPSHOT,
    vendor_id: intent.vendor_id,
    amount: intent.amount,
    currency: intent.currency,
    daily_spent: 0,
  };
}

async function harness(script: Record<string, (input: WireIntent) => unknown>, overrides: Partial<AgentConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vg-"));
  const auditPath = join(dir, "audit.jsonl");
  const config: AgentConfig = {
    contractTail: "vendor-guard",
    tenantDid: TENANT_DID,
    approvalSecret: SECRET,
    auditPath,
    maxApprovalTtlSecs: 900,
    allowReview: false,
    ...overrides,
  };
  const contract = new FakeContract(script);
  const audit = new AuditLog(auditPath);
  const gate = new PaymentGate(contract, config, audit);
  return { gate, contract, audit, auditPath };
}

const INTENT: PayoutIntent = {
  vendorId: "acme-cloud",
  amount: 12_500,
  currency: "USD",
  memo: "invoice INV-2026-0042",
};

function freshToken(intent: PayoutIntent = INTENT, now = Math.floor(Date.now() / 1000)) {
  return mintApproval(SECRET, intent, { approver: "finance@example.com", now });
}

test("a denied intent never reaches the payout function", async () => {
  const { gate, contract, auditPath } = await harness({
    "check-payout": (i) => ({
      ...allowedCheck(i),
      decision: "deny",
      reasons: [{ code: "vendor_unknown", detail: "no vendor 'evil'" }],
    }),
  });

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "refused");
  assert.equal(out.decision, "deny");
  assert.equal(contract.callsTo("payout"), 0, "policy denial must not call payout");
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  const events = lines.map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ["check", "refused"]);
});

test("an allowed intent with a valid approval pays and records the nonce", async () => {
  const { gate, contract, auditPath } = await harness({
    "check-payout": (i) => allowedCheck(i),
    payout: () => ({
      status: "paid",
      id: "pay_1",
      reference: "BANK-REF-9001",
      vendor_id: "acme-cloud",
      amount: 12_500,
      currency: "USD",
      daily_total: 12_500,
      review_flagged: false,
    }),
  });

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "paid");
  assert.equal(out.reference, "BANK-REF-9001");
  assert.equal(contract.callsTo("payout"), 1);
  const entries = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const paid = entries.find((e) => e.event === "paid");
  assert.ok(paid, "a paid entry must be written");
  assert.ok(paid.nonce, "the spent nonce must be recorded for replay detection");
  assert.equal(paid.approver, "finance@example.com");
});

test("the same approval token cannot be used twice", async () => {
  const { gate, contract } = await harness({
    "check-payout": (i) => allowedCheck(i),
    payout: () => ({ status: "paid", reference: "REF-1" }),
  });
  const token = freshToken();

  const first = await gate.pay({ intent: INTENT, approvalToken: token });
  const second = await gate.pay({ intent: INTENT, approvalToken: token });

  assert.equal(first.status, "paid");
  assert.equal(second.status, "refused");
  assert.match(second.reasons![0]!.detail, /already been spent/);
  assert.equal(contract.callsTo("payout"), 1, "the replay must not reach the bank");
});

test("a token for a different amount is refused and payout is never called", async () => {
  const { gate, contract } = await harness({
    "check-payout": (i) => allowedCheck(i),
    payout: () => ({ status: "paid", reference: "REF" }),
  });

  const cheap = freshToken({ ...INTENT, amount: 100 });
  const out = await gate.pay({ intent: { ...INTENT, amount: 12_500 }, approvalToken: cheap });

  assert.equal(out.status, "refused");
  assert.match(out.reasons![0]!.detail, /authorises 100, not 12500/);
  assert.equal(contract.callsTo("payout"), 0);
});

test("review-flagged intents are refused by default", async () => {
  const { gate, contract, auditPath } = await harness({
    "check-payout": (i) => ({
      ...allowedCheck(i),
      decision: "review",
      reasons: [{ code: "near_daily_cap", detail: "would use 92% of the daily budget" }],
    }),
    payout: () => ({ status: "paid", reference: "REF" }),
  });

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "refused");
  assert.equal(out.reviewFlagged, true);
  assert.equal(contract.callsTo("payout"), 0);
  const entries = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(entries.at(-1)!.detail, /AGENT_ALLOW_REVIEW is false/);
});

test("review-flagged intents proceed when the operator opts in", async () => {
  const { gate, contract } = await harness(
    {
      "check-payout": (i) => ({ ...allowedCheck(i), decision: "review" }),
      payout: () => ({ status: "paid", reference: "REF-REVIEWED" }),
    },
    { allowReview: true },
  );

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "paid");
  assert.equal(out.reviewFlagged, true);
  assert.equal(contract.callsTo("payout"), 1);
});

test("a contract refusal at payout time is logged as a state race, not a success", async () => {
  const { gate, auditPath } = await harness({
    "check-payout": (i) => allowedCheck(i),
    payout: () => ({
      status: "refused",
      reasons: [{ code: "daily_cap_exceeded", detail: "another payout took the rest" }],
    }),
  });

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "refused");
  const entries = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const last = entries.at(-1)!;
  assert.equal(last.event, "refused");
  assert.match(last.detail, /policy state changed between check and payout/);
});

test("an upstream failure is recorded with the vendor's status code", async () => {
  const { gate, auditPath } = await harness({
    "check-payout": (i) => allowedCheck(i),
    payout: () => ({ status: "upstream_error", reference: "BANK-REF-9002", upstream_code: 503 }),
  });

  const out = await gate.pay({ intent: INTENT, approvalToken: freshToken() });

  assert.equal(out.status, "upstream_error");
  const entries = (await readFile(auditPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const last = entries.at(-1)!;
  assert.equal(last.event, "upstream_error");
  assert.match(last.detail, /HTTP 503/);
});

test("check() moves no money and is safe to call repeatedly", async () => {
  const { gate, contract } = await harness({ "check-payout": (i) => allowedCheck(i) });
  await gate.check(INTENT);
  await gate.check(INTENT);
  assert.equal(contract.callsTo("payout"), 0);
  assert.equal(contract.callsTo("check-payout"), 2);
});

test("getPolicy surfaces the enclave's policy and ignored overrides", async () => {
  const { gate } = await harness({
    "get-policy": () => ({
      contract_version: "0.1.0",
      policy: POLICY_SNAPSHOT,
      vendors: [
        { id: "acme-cloud", name: "Acme", currency: "USD", country: "US", active: true, bank_last4: "4242" },
      ],
      ignored_overrides: ["max_single_payout: override 999999 refused (would loosen 50000)"],
    }),
  });

  const p = await gate.getPolicy();

  assert.equal(p.contract_version, "0.1.0");
  assert.equal(p.vendors.length, 1);
  assert.equal(p.vendors[0]!.bank_last4, "4242");
  assert.equal(p.ignored_overrides.length, 1);
});

test("the canonical contract name is derived, never passed in", async () => {
  const { gate } = await harness({});
  assert.equal(gate.contractName, "z:abcdef0123456789abcdef0123456789abcdef01:vendor-guard");
});
