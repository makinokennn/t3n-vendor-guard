#!/usr/bin/env node
/**
 * The approver's tool — a separate entry point, on purpose.
 *
 * This is the ONLY thing in the repository that can mint an approval token. It is
 * a distinct binary from the agent's CLI, so the natural deployment is: this runs
 * on a finance machine (or behind a human-operated service), and the agent host
 * gets only the verification secret.
 *
 * The distinction matters even though both need the same HMAC key today: the
 * *capability* to authorise is a different thing from the *capability* to pay,
 * and keeping them in separate programs means an operator can later swap HMAC for
 * an Ed25519 signature — the agent would then hold a public key and become
 * genuinely unable to mint. See `src/approval.ts` for the trade-off.
 *
 * Usage:
 *   vendor-guard-mint --vendor acme-cloud --amount 12500 --currency USD \
 *                     --memo "INV-2026-0042" --approver finance@example.com [--ttl 900]
 */

import { parseArgs } from "node:util";
import { mintApproval } from "./approval.ts";

const USAGE = `vendor-guard-mint — mint a human approval token

Usage: vendor-guard-mint --vendor <id> --amount <cents> --currency <ISO> --approver <who> [--memo <text>] [--ttl <secs>]

The token is bound to this exact vendor/amount/currency/memo. Changing any of
them invalidates it, so a token cannot be redirected or inflated after the fact.

Reads AGENT_APPROVAL_SECRET from the environment. Print the token to stdout; it
is safe to hand to the agent, but it is a bearer credential for one payment, so
treat it like a cheque.
`;

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      vendor: { type: "string" },
      amount: { type: "string" },
      currency: { type: "string" },
      memo: { type: "string" },
      approver: { type: "string" },
      ttl: { type: "string" },
    },
    allowPositionals: false,
  });

  if (process.argv.length <= 2) {
    process.stdout.write(USAGE);
    process.exit(2);
  }

  const secret = process.env.AGENT_APPROVAL_SECRET;
  if (!secret) {
    process.stderr.write("vendor-guard-mint: AGENT_APPROVAL_SECRET is not set\n");
    process.exit(2);
  }

  const vendor = values.vendor;
  const amountRaw = values.amount;
  const currency = values.currency;
  const approver = values.approver;
  if (!vendor || !amountRaw || !currency || !approver) {
    process.stderr.write("vendor-guard-mint: --vendor, --amount, --currency and --approver are all required\n\n");
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (!/^\d+$/.test(amountRaw)) {
    process.stderr.write(`vendor-guard-mint: --amount must be integer minor units (cents), got '${amountRaw}'\n`);
    process.exit(2);
  }
  const amount = Number(amountRaw);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    process.stderr.write(`vendor-guard-mint: --amount must be a positive integer, got '${amountRaw}'\n`);
    process.exit(2);
  }

  const ttl = values.ttl ? Number(values.ttl) : 900;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    process.stderr.write(`vendor-guard-mint: --ttl must be a positive integer, got '${values.ttl}'\n`);
    process.exit(2);
  }

  const token = mintApproval(
    secret,
    { vendorId: vendor, amount, currency, memo: values.memo },
    { approver, ttlSecs: ttl },
  );

  process.stdout.write(token + "\n");
  process.stderr.write(
    `minted: ${amount} ${currency.toUpperCase()} -> ${vendor} for ${approver}, valid ${ttl}s\n`,
  );
}

main();
