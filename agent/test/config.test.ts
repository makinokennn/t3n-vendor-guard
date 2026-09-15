import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, canonicalContractName } from "../src/config.ts";
import { VendorGuardError } from "../src/types.ts";

const GOOD_SECRET = "0123456789abcdef0123456789abcdef"; // 32 bytes

function baseEnv(): NodeJS.ProcessEnv {
  return {
    AGENT_CONTRACT_TAIL: "vendor-guard",
    AGENT_TENANT_DID: "did:t3n:abcdef0123456789abcdef0123456789abcdef01",
    AGENT_APPROVAL_SECRET: GOOD_SECRET,
  };
}

test("loads a valid config and applies defaults", () => {
  const cfg = loadConfig(baseEnv());
  assert.equal(cfg.contractTail, "vendor-guard");
  assert.equal(cfg.auditPath, "./vendor-guard-audit.jsonl");
  assert.equal(cfg.maxApprovalTtlSecs, 900);
  assert.equal(cfg.allowReview, false);
});

test("reports every problem at once instead of one at a time", () => {
  let err: unknown;
  try {
    loadConfig({ AGENT_TENANT_DID: "not-a-did", AGENT_APPROVAL_SECRET: "short" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof VendorGuardError);
  assert.equal(err.kind, "config");
  // All three problems must be named in one message.
  assert.match(err.message, /AGENT_CONTRACT_TAIL is required/);
  assert.match(err.message, /must look like 'did:t3n:<hex>'/);
  assert.match(err.message, /at least 32 bytes/);
});

test("refuses a short approval secret", () => {
  const env = baseEnv();
  env.AGENT_APPROVAL_SECRET = "too-short";
  assert.throws(() => loadConfig(env), /at least 32 bytes/);
});

test("refuses a non-boolean AGENT_ALLOW_REVIEW", () => {
  const env = baseEnv();
  env.AGENT_ALLOW_REVIEW = "yes";
  assert.throws(() => loadConfig(env), /must be 'true' or 'false'/);
});

test("refuses a non-positive TTL", () => {
  const env = baseEnv();
  env.AGENT_MAX_APPROVAL_TTL_SECS = "0";
  assert.throws(() => loadConfig(env), /positive integer/);
});

test("derives the canonical contract name from the tenant DID", () => {
  const name = canonicalContractName(
    "did:t3n:abcdef0123456789abcdef0123456789abcdef01",
    "vendor-guard",
  );
  assert.equal(name, "z:abcdef0123456789abcdef0123456789abcdef01:vendor-guard");
});

test("rejects a tenant DID with no hex body when building a contract name", () => {
  assert.throws(() => canonicalContractName("did:t3n:", "x"), /no hex body/);
});
