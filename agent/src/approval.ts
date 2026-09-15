/**
 * Human approval tokens.
 *
 * The single most important property of this whole design: **the agent must not
 * be able to authorise its own payment.** Everything else is policy; this is the
 * control that survives the agent being wrong, confused, or adversarially
 * prompted.
 *
 * The mechanism is an HMAC-signed token minted by the *approver* (a human, a
 * finance system, whatever) and verified by the agent. The token binds the exact
 * intent — vendor, amount, currency, memo — so a token issued for a $50 invoice
 * cannot be replayed for a $50,000 transfer. Because the MAC covers the whole
 * payload, the payload cannot be edited either.
 *
 * The agent holds the *verification* secret. That is deliberate and worth being
 * explicit about: verification requires the same key as minting, so a compromised
 * agent host could forge approvals. What this design buys is that the agent
 * cannot approve *by accident or by persuasion* — it has no code path that mints
 * a token, and the token is bound to an amount a human chose. A production
 * deployment should move minting behind an out-of-band approver service (or an
 * asymmetric signature) so the agent host holds only a public key; see
 * `mintApproval`'s note. This is a real, documented limitation, not a hidden one.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PayoutIntent, Reason } from "./types.ts";
import { VendorGuardError } from "./types.ts";

const TOKEN_VERSION = "vg1";
const NONCE_BYTES = 16;

export interface ApprovalToken {
  v: number;
  vendorId: string;
  amount: number;
  currency: string;
  memoHash: string;
  approver: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MintOptions {
  approver: string;
  ttlSecs?: number;
  now?: number;
}

export interface VerifyOptions {
  now?: number;
  maxTtlSecs?: number;
  /** Reject this nonce as already spent. */
  isNonceUsed?: (nonce: string) => boolean | Promise<boolean>;
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Stable, order-independent hash of a memo. `undefined` and `""` hash the
 *  same, so an approver cannot be tricked by a whitespace-only memo. */
export function memoHash(memo: string | undefined): string {
  const normalised = (memo ?? "").trim();
  return createHmac("sha256", "vendor-guard-memo-v1")
    .update(normalised, "utf8")
    .digest("base64url");
}

function canonicalPayload(t: ApprovalToken): string {
  // Explicit field order, no JSON.stringify of an object literal: key order in
  // an object is not a security boundary, so it must not be load-bearing.
  return [
    TOKEN_VERSION,
    String(t.v),
    t.vendorId,
    String(t.amount),
    t.currency,
    t.memoHash,
    t.approver,
    t.nonce,
    String(t.issuedAt),
    String(t.expiresAt),
  ].join("\n");
}

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

/**
 * Mint an approval token for exactly one intent.
 *
 * Called by the approver's tooling, not by the agent. In production, move this
 * behind a service the agent cannot reach (or swap HMAC for an Ed25519
 * signature) so that possessing the agent host does not imply the ability to
 * approve.
 */
export function mintApproval(
  secret: string,
  intent: PayoutIntent,
  opts: MintOptions,
): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSecs ?? 900;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new VendorGuardError("approval", `ttlSecs must be a positive integer, got ${ttl}`);
  }
  const token: ApprovalToken = {
    v: 1,
    vendorId: intent.vendorId,
    amount: intent.amount,
    currency: intent.currency.trim().toUpperCase(),
    memoHash: memoHash(intent.memo),
    approver: opts.approver,
    nonce: randomBytes(NONCE_BYTES).toString("hex"),
    issuedAt: now,
    expiresAt: now + ttl,
  };
  const payload = canonicalPayload(token);
  return `${TOKEN_VERSION}.${b64u(Buffer.from(payload, "utf8"))}.${b64u(sign(secret, payload))}`;
}

/**
 * Verify a token against the intent it is supposed to authorise.
 *
 * Fails closed on every path: wrong shape, bad MAC, expired, not-yet-valid,
 * wrong vendor, wrong amount, wrong currency, changed memo, or a replayed nonce.
 * The MAC is compared in constant time.
 */
export async function verifyApproval(
  secret: string,
  token: string,
  intent: PayoutIntent,
  opts: VerifyOptions = {},
): Promise<ApprovalToken> {
  const deny = (detail: string): never => {
    throw new VendorGuardError("approval", `approval rejected: ${detail}`);
  };

  if (typeof token !== "string" || token.length === 0) deny("token is empty");
  const parts = token.split(".");
  if (parts.length !== 3) deny("token is not a 3-part vg1 token");
  const [version, payloadB64, macB64] = parts;
  if (version !== TOKEN_VERSION) deny(`unsupported token version '${version}'`);

  let payload: string;
  let providedMac: Buffer;
  try {
    payload = Buffer.from(payloadB64!, "base64url").toString("utf8");
    providedMac = Buffer.from(macB64!, "base64url");
  } catch {
    return deny("token is not valid base64url");
  }

  const expectedMac = sign(secret, payload);
  if (
    providedMac.length !== expectedMac.length ||
    !timingSafeEqual(providedMac, expectedMac)
  ) {
    deny("signature does not verify — token was not minted with this secret");
  }

  // Only after the MAC verifies is it safe to parse and trust the fields.
  const fields = payload.split("\n");
  if (fields.length !== 10) deny("malformed token payload");
  const pick = (i: number): string => {
    const v = fields[i];
    if (v === undefined) return deny(`malformed token payload: field ${i} missing`);
    return v;
  };

  const t: ApprovalToken = {
    v: Number(pick(1)),
    vendorId: pick(2),
    amount: Number(pick(3)),
    currency: pick(4),
    memoHash: pick(5),
    approver: pick(6),
    nonce: pick(7),
    issuedAt: Number(pick(8)),
    expiresAt: Number(pick(9)),
  };
  if (t.v !== 1) deny(`unsupported payload version ${t.v}`);
  if (!Number.isInteger(t.amount) || t.amount < 0) deny("token amount is not a non-negative integer");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (t.expiresAt <= now) deny(`token expired at ${t.expiresAt} (now ${now})`);
  if (t.issuedAt > now + 60) deny(`token issued in the future (${t.issuedAt} > ${now})`);

  const maxTtl = opts.maxTtlSecs ?? 900;
  if (t.expiresAt - t.issuedAt > maxTtl) {
    deny(`token lifetime ${t.expiresAt - t.issuedAt}s exceeds the ${maxTtl}s maximum`);
  }

  // --- binding to the requested intent -----------------------------------
  if (t.vendorId !== intent.vendorId) {
    deny(`token is for vendor '${t.vendorId}', not '${intent.vendorId}'`);
  }
  if (t.amount !== intent.amount) {
    deny(`token authorises ${t.amount}, not ${intent.amount}`);
  }
  if (t.currency !== intent.currency.trim().toUpperCase()) {
    deny(`token authorises ${t.currency}, not '${intent.currency}'`);
  }
  if (t.memoHash !== memoHash(intent.memo)) {
    deny("token was issued for a different memo — the intent has been altered");
  }

  if (opts.isNonceUsed && (await opts.isNonceUsed(t.nonce))) {
    deny(`token nonce '${t.nonce}' has already been spent (replay)`);
  }

  return t;
}

/** Reasons for a rejected approval, for callers that prefer data over throwing. */
export function approvalFailureReasons(err: unknown): Reason[] {
  if (err instanceof VendorGuardError) {
    return [{ code: "approval_invalid", detail: err.message }];
  }
  return [{ code: "approval_invalid", detail: String(err) }];
}
