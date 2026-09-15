import { test } from "node:test";
import assert from "node:assert/strict";
import { mintApproval, verifyApproval, memoHash } from "../src/approval.ts";
import { VendorGuardError } from "../src/types.ts";
import type { PayoutIntent } from "../src/types.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";
const NOW = 1_800_000_000;

const intent: PayoutIntent = {
  vendorId: "acme-cloud",
  amount: 12_500,
  currency: "USD",
  memo: "invoice INV-2026-0042",
};

test("mint then verify round-trips", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance@example.com", now: NOW });
  const t = await verifyApproval(SECRET, token, intent, { now: NOW + 10 });
  assert.equal(t.vendorId, "acme-cloud");
  assert.equal(t.amount, 12_500);
  assert.equal(t.currency, "USD");
  assert.equal(t.approver, "finance@example.com");
});

test("a token minted for one amount cannot be replayed for another", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW });
  await assert.rejects(
    () => verifyApproval(SECRET, token, { ...intent, amount: 999_999 }, { now: NOW + 1 }),
    /token authorises 12500, not 999999/,
  );
});

test("a token cannot be redirected to a different vendor", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW });
  await assert.rejects(
    () => verifyApproval(SECRET, token, { ...intent, vendorId: "evil-vendor" }, { now: NOW + 1 }),
    /not 'evil-vendor'/,
  );
});

test("editing the memo invalidates the approval", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW });
  await assert.rejects(
    () => verifyApproval(SECRET, token, { ...intent, memo: "totally fine, honest" }, { now: NOW + 1 }),
    /different memo/,
  );
});

test("an absent memo and a whitespace-only memo hash identically", () => {
  assert.equal(memoHash(undefined), memoHash("   "));
  assert.equal(memoHash("x"), memoHash("  x  "));
});

test("a token signed with another secret is rejected", async () => {
  const token = mintApproval(OTHER_SECRET, intent, { approver: "attacker", now: NOW });
  await assert.rejects(
    () => verifyApproval(SECRET, token, intent, { now: NOW + 1 }),
    /signature does not verify/,
  );
});

test("tampering with the payload is caught by the MAC", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW });
  const [v, payload, mac] = token.split(".");
  // The payload is newline-joined fields; swap the amount field for a bigger one.
  const decoded = Buffer.from(payload!, "base64url").toString("utf8");
  const forged = decoded.replace("\n12500\n", "\n99999\n");
  assert.notEqual(forged, decoded, "the tamper must actually change the payload");
  const tampered = `${v}.${Buffer.from(forged, "utf8").toString("base64url")}.${mac}`;
  await assert.rejects(
    () => verifyApproval(SECRET, tampered, intent, { now: NOW + 1 }),
    /signature does not verify/,
  );
});

test("expired tokens are rejected", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW, ttlSecs: 60 });
  await assert.rejects(
    () => verifyApproval(SECRET, token, intent, { now: NOW + 61 }),
    /expired at/,
  );
});

test("a token with an absurd lifetime is rejected even if unexpired", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW, ttlSecs: 86_400 });
  await assert.rejects(
    () => verifyApproval(SECRET, token, intent, { now: NOW + 1, maxTtlSecs: 900 }),
    /exceeds the 900s maximum/,
  );
});

test("a token issued in the future is rejected", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW + 600 });
  await assert.rejects(
    () => verifyApproval(SECRET, token, intent, { now: NOW }),
    /issued in the future/,
  );
});

test("a spent nonce is refused (replay protection)", async () => {
  const token = mintApproval(SECRET, intent, { approver: "finance", now: NOW });
  const first = await verifyApproval(SECRET, token, intent, { now: NOW + 1 });
  await assert.rejects(
    () => verifyApproval(SECRET, token, intent, { now: NOW + 2, isNonceUsed: (n) => n === first.nonce }),
    /already been spent/,
  );
});

test("malformed tokens fail closed with a clear reason", async () => {
  await assert.rejects(() => verifyApproval(SECRET, "", intent), /token is empty/);
  await assert.rejects(() => verifyApproval(SECRET, "not-a-token", intent), /3-part/);
  await assert.rejects(() => verifyApproval(SECRET, "vg9.abc.def", intent), /unsupported token version/);
  await assert.rejects(
    () => verifyApproval(SECRET, "vg1.!!!!.????", intent, { now: NOW }),
    /signature does not verify|not valid base64url/,
  );
});

test("currency comparison is case- and whitespace-insensitive", async () => {
  const token = mintApproval(SECRET, { ...intent, currency: "usd" }, { approver: "f", now: NOW });
  const t = await verifyApproval(SECRET, token, { ...intent, currency: " USD " }, { now: NOW + 1 });
  assert.equal(t.currency, "USD");
});

test("mintApproval refuses a nonsense TTL", () => {
  assert.throws(
    () => mintApproval(SECRET, intent, { approver: "f", ttlSecs: 0 }),
    (e: unknown) => e instanceof VendorGuardError && /ttlSecs/.test((e as Error).message),
  );
});
