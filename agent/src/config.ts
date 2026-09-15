/**
 * Configuration loading.
 *
 * Every field is read from the environment, validated up front, and reported as
 * **one** error naming **all** the problems. A config loader that fails on the
 * first missing variable turns deployment into a guessing game, and in an
 * autonomous agent it means the agent boots, half-works, and then fails a
 * payment for a reason that was knowable at startup.
 */

import type { AgentConfig } from "./types.ts";
import { VendorGuardError } from "./types.ts";

const MIN_SECRET_BYTES = 32;

function required(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined || v.trim() === "") return undefined;
  return v.trim();
}

function parsePositiveInt(
  raw: string | undefined,
  key: string,
  fallback: number,
  problems: string[],
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${key} must be a positive integer, got '${raw}'`);
    return fallback;
  }
  return n;
}

/**
 * Load and validate configuration from the environment.
 *
 * `AGENT_CONTRACT_TAIL` and `AGENT_TENANT_DID` are mandatory; the rest default
 * to safe values. The approval secret is mandatory and is required to be long
 * enough to be worth calling a secret — a 6-character HMAC key is not a control,
 * and accepting one would make the approval step theatre.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const problems: string[] = [];

  const contractTail = required(env, "AGENT_CONTRACT_TAIL");
  if (!contractTail) problems.push("AGENT_CONTRACT_TAIL is required");

  const tenantDid = required(env, "AGENT_TENANT_DID");
  if (!tenantDid) {
    problems.push("AGENT_TENANT_DID is required");
  } else if (!/^did:t3n:[0-9a-fA-F]+$/.test(tenantDid)) {
    problems.push(
      `AGENT_TENANT_DID must look like 'did:t3n:<hex>', got '${tenantDid}'`,
    );
  }

  const approvalSecret = required(env, "AGENT_APPROVAL_SECRET");
  if (!approvalSecret) {
    problems.push(
      "AGENT_APPROVAL_SECRET is required (the approver's HMAC key; the agent cannot mint approvals without it being present only on the approver's side)",
    );
  } else if (Buffer.byteLength(approvalSecret, "utf8") < MIN_SECRET_BYTES) {
    problems.push(
      `AGENT_APPROVAL_SECRET must be at least ${MIN_SECRET_BYTES} bytes; a short key makes the approval token forgeable`,
    );
  }

  const allowReviewRaw = env.AGENT_ALLOW_REVIEW ?? "false";
  if (!/^(true|false)$/.test(allowReviewRaw)) {
    problems.push(`AGENT_ALLOW_REVIEW must be 'true' or 'false', got '${allowReviewRaw}'`);
  }

  const maxApprovalTtlSecs = parsePositiveInt(
    env.AGENT_MAX_APPROVAL_TTL_SECS,
    "AGENT_MAX_APPROVAL_TTL_SECS",
    900,
    problems,
  );

  if (problems.length > 0) {
    throw new VendorGuardError(
      "config",
      `vendor-guard configuration is invalid:\n  - ${problems.join("\n  - ")}`,
    );
  }

  return {
    contractTail: contractTail!,
    tenantDid: tenantDid!,
    approvalSecret: approvalSecret!,
    auditPath: required(env, "AGENT_AUDIT_PATH") ?? "./vendor-guard-audit.jsonl",
    maxApprovalTtlSecs,
    allowReview: allowReviewRaw === "true",
  };
}

/** The canonical on-chain name of a tenant contract, e.g. `z:<tid>:payments`. */
export function canonicalContractName(tenantDid: string, tail: string): string {
  const hex = tenantDid.slice("did:t3n:".length);
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new VendorGuardError("config", `tenant DID has no hex body: ${tenantDid}`);
  }
  return `z:${hex}:${tail}`;
}
