#!/usr/bin/env node
/**
 * vendor-guard CLI.
 *
 * The agent's operator interface. Subcommands map one-to-one onto things you
 * would actually do next to this agent:
 *
 *   policy                       show the enclave's effective policy and vendors
 *   check  --vendor --amount ... dry-run an intent (moves no money)
 *   pay    --vendor --amount ... --approval-token <t>   execute a payout
 *   audit  [--limit N]           read the local audit log
 *   mcp                          run as an MCP server over stdio
 *
 * Deliberately NOT here: minting approvals (`approver.ts`) and editing the vendor
 * registry (`admin.ts`). Those are human actions, in separate entry points, so
 * that no single binary an autonomous process can reach is able to both request
 * and authorise a payment.
 *
 * Amounts are always minor units (cents). Passing `12.50` is rejected rather than
 * silently coerced, because a silent coercion is exactly the bug that turns a
 * $12.50 invoice into a $1250 transfer.
 */

import { parseArgs } from "node:util";
import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { PaymentGate } from "./gate.ts";
import { SdkContractInvoker } from "./invoker.ts";
import { runStdio } from "./mcp.ts";
import type { PayoutIntent } from "./types.ts";
import { VendorGuardError } from "./types.ts";

const USAGE = `vendor-guard — policy-gated vendor payouts on Terminal 3

Usage: vendor-guard <command> [options]

Commands:
  policy                       Show effective policy + vendor registry (from the enclave)
  check                        Dry-run a payout intent; moves no money
  pay                          Execute a payout; requires a human approval token
  audit                        Print the local audit log
  mcp                          Serve the gate as an MCP server on stdio

Options (check/pay):
  --vendor <id>                Vendor id (required)
  --amount <cents>             Amount in MINOR units, integer (required)
  --currency <ISO>             ISO-4217 currency (required)
  --memo <text>                Payment memo (required above the policy threshold)
  --approval-token <token>     Human-minted approval token (pay only; required)
  --json                       Machine-readable output

Environment:
  AGENT_CONTRACT_TAIL          Contract tail, e.g. 'vendor-guard' (required)
  AGENT_TENANT_DID             did:t3n:<hex> (required)
  AGENT_APPROVAL_SECRET        Approver HMAC key, >=32 bytes (required)
  AGENT_AUDIT_PATH             Audit log path (default ./vendor-guard-audit.jsonl)
  AGENT_MAX_APPROVAL_TTL_SECS  Max accepted token lifetime (default 900)
  AGENT_ALLOW_REVIEW           'true' to let review-flagged payouts proceed (default false)
  T3N_AGENT_KEY                The AGENT's own API key — never the tenant's key
  T3N_ENVIRONMENT              sandbox | testnet | production (default testnet)
`;

function die(message: string, code = 2): never {
  process.stderr.write(`vendor-guard: ${message}\n`);
  process.exit(code);
}

function requireString(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim() === "") die(`${flag} is required`);
  return value;
}

function parseAmount(raw: unknown): number {
  const s = requireString(raw, "--amount");
  if (!/^\d+$/.test(s)) {
    die(
      `--amount must be an integer number of minor units (cents). Got '${s}'. ` +
        `If you meant ${s} major units, pass ${s.replace(".", "")} explicitly — ` +
        `vendor-guard will not guess, because guessing is how decimal points become ten-x errors.`,
    );
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) die(`--amount must be a positive integer, got '${s}'`);
  return n;
}

async function buildGate() {
  const config = loadConfig();
  const apiKey = process.env.T3N_AGENT_KEY;
  if (!apiKey) {
    throw new VendorGuardError(
      "config",
      "T3N_AGENT_KEY is not set. This must be the AGENT's own API key (its own DID, its own credits) — not your tenant key. See docs/SETUP.md.",
    );
  }
  const env = (process.env.T3N_ENVIRONMENT ?? "testnet") as "sandbox" | "testnet" | "production";
  const invoker = new SdkContractInvoker({
    tenantDid: config.tenantDid,
    contractTail: config.contractTail,
    apiKey,
    environment: env,
    baseUrl: process.env.T3N_BASE_URL,
    onCall: (fn, phase) => {
      if (process.env.VG_VERBOSE === "1") process.stderr.write(`[t3n] ${fn} ${phase}\n`);
    },
  });
  const audit = new AuditLog(config.auditPath);
  return { gate: new PaymentGate(invoker, config, audit), audit, config };
}

function intentFrom(values: Record<string, unknown>): PayoutIntent {
  return {
    vendorId: requireString(values.vendor, "--vendor"),
    amount: parseAmount(values.amount),
    currency: requireString(values.currency, "--currency").toUpperCase(),
    memo: typeof values.memo === "string" ? values.memo : undefined,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      vendor: { type: "string" },
      amount: { type: "string" },
      currency: { type: "string" },
      memo: { type: "string" },
      "approval-token": { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  switch (command) {
    case "policy": {
      const { gate } = await buildGate();
      const policy = await gate.getPolicy();
      if (values.json) {
        process.stdout.write(JSON.stringify(policy, null, 2) + "\n");
      } else {
        const p = policy.policy;
        process.stdout.write(
          [
            `contract version : ${policy.contract_version}`,
            `max single payout: ${p.max_single_payout} (minor units)`,
            `max daily total  : ${p.max_daily_total}`,
            `currencies       : ${p.allowed_currencies.join(", ")}`,
            `memo required >  : ${p.require_memo_over}`,
            `blocked countries: ${p.blocked_countries.length ? p.blocked_countries.join(", ") : "(none)"}`,
            "",
            `vendors (${policy.vendors.length}):`,
            ...policy.vendors.map(
              (v) => `  ${v.active ? " " : "x"} ${v.id}  ${v.name}  ${v.currency}  ${v.country}  ****${v.bank_last4}`,
            ),
            policy.ignored_overrides.length
              ? `\nREFUSED policy overrides:\n${policy.ignored_overrides.map((o) => `  ! ${o}`).join("\n")}`
              : "",
          ]
            .filter((l) => l !== "")
            .join("\n") + "\n",
        );
      }
      return;
    }

    case "check": {
      const { gate } = await buildGate();
      const result = await gate.check(intentFrom(values));
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exit(result.decision === "allow" ? 0 : 1);
    }

    case "pay": {
      const { gate } = await buildGate();
      const approvalToken = requireString(values["approval-token"], "--approval-token");
      const outcome = await gate.pay({ intent: intentFrom(values), approvalToken });
      process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
      process.exit(outcome.status === "paid" ? 0 : 1);
    }

    case "audit": {
      const config = loadConfig();
      const log = new AuditLog(config.auditPath);
      const entries = await log.readAll();
      const limit = values.limit ? Number(values.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive integer");
      const tail = entries.slice(-limit);
      if (values.json) {
        process.stdout.write(JSON.stringify(tail, null, 2) + "\n");
      } else {
        for (const e of tail) {
          const amount = e.intent ? ` ${e.intent.amount} ${e.intent.currency} -> ${e.intent.vendorId}` : "";
          const why = e.reasons?.length ? ` [${e.reasons.map((r) => r.code).join(",")}]` : "";
          const ref = e.reference ? ` ref=${e.reference}` : "";
          process.stdout.write(`${e.ts}  ${e.event.padEnd(18)}${amount}${why}${ref}\n`);
        }
      }
      return;
    }

    case "mcp": {
      const { gate, audit } = await buildGate();
      await runStdio({
        gate,
        auditTail: async (limit) => {
          const entries = await audit.readAll();
          return entries.slice(-limit);
        },
      });
      return;
    }

    default:
      die(`unknown command '${command}'\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof VendorGuardError) {
    process.stderr.write(`vendor-guard [${err.kind}]: ${err.message}\n`);
    if (err.reasons.length) process.stderr.write(JSON.stringify(err.reasons, null, 2) + "\n");
    process.exit(2);
  }
  process.stderr.write(`vendor-guard: unexpected error: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(70);
});
