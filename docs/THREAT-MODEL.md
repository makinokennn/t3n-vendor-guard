# Threat model

Written to be read by someone deciding whether to put real money behind this. It lists what is
defended, how, and — more usefully — what is **not**.

## Assets

| Asset | Where it lives | Loss means |
| --- | --- | --- |
| Tenant funds | the vendor's account / the bank | money gone |
| Vendor API key | `z:<tid>:secrets`, inside the TEE | attacker can initiate transfers as the tenant |
| Approval HMAC secret | agent host + finance machine | attacker can authorise arbitrary payments |
| Vendor registry | `z:<tid>:state` | attacker can redirect payouts to their own account |
| Audit log | local disk (JSONL) | repudiation; the replay check weakens |

## Adversaries

**A1 — Prompt injection.** Malicious text reaches the model: an invoice PDF, a vendor email, a
web page. The model is persuaded to pay an attacker, inflate an amount, or split a payment.

**A2 — A compromised agent host.** An attacker has code execution on the machine running the
agent, but not on the finance machine and not in the enclave.

**A3 — A malicious tenant owner.** Someone with legitimate control-plane access — i.e. the
customer themselves, or someone who has stolen their credentials.

**A4 — A hostile vendor / upstream.** The payee's API returns crafted responses, hangs, or lies
about success.

**A5 — A hostile network.** The link between agent and cluster is observed or tampered with.

## Defences

### A1 — Prompt injection

This is the threat the whole design exists for.

| Attack | Outcome | Enforced by |
| --- | --- | --- |
| Pay an unregistered vendor | deny `vendor_unknown` | `policy.rs`, vendor read from enclave state |
| Raise a limit by asking nicely | no tool exists to change policy | MCP surface (`mcp.ts`) |
| Mint your own approval | the agent holds no minting path | separate `approver.ts` binary |
| Split a payment under the cap | cumulative daily ledger | `policy.rs` + `z:<tid>:state` |
| Backdate to yesterday's budget | time comes from `cluster-timestamp-secs` | host interface |
| Pay a blocked country | `blocked_countries` vs. the enclave's vendor record | `policy.rs` |
| Omit the memo to hide the purpose | `memo_required` above threshold | `policy.rs` |
| Send the money somewhere new | payout URL is a field on the vendor record, not on the request | `api.rs` |
| Reuse an old approval for a new amount | token is bound to amount/currency/vendor/memo | `approval.ts` |
| Read the vendor API key to exfiltrate it | no export returns it | `api.rs` |
| Bypass the gate by calling the vendor directly | the API key exists only inside the enclave | `store.rs` |
| Get the approver's email for social engineering | `{{profile.*}}` resolved by the host, never returned | `api.rs` + host |

The load-bearing point: **none of these depend on the model behaving.** They are properties of
what the model can reach.

### A2 — Compromised agent host

| Attack | Outcome |
| --- | --- |
| Mint an approval token | **Possible.** The host holds the HMAC secret. |
| Suppress an audit entry | **Possible.** The log is a local file. |
| Alter the audit log | **Possible** — nothing signs it. |
| Read the vendor API key | **No.** It lives in the enclave. |
| Exceed a policy limit | **No.** The enclave re-decides at payout time. |
| Redirect a payout URL | **No.** It comes from enclave state. |
| Forge a policy response | **No.** `validate.ts` rejects malformed shapes; and the payout path re-decides in the enclave regardless of what the agent believes. |

**This is the honest weak link.** Two mitigations are in place, neither complete:

1. **The split into two binaries** (`vendor-guard` vs `vendor-guard-mint`) means the agent host
   does not *need* the minting code. Run minting on the finance machine only.
2. **The seam to close it properly:** replace HMAC with Ed25519. The finance machine signs; the
   agent verifies against a public key and becomes genuinely unable to mint. The token format
   already carries a version byte for exactly this migration.

A signing key on the agent host is a real limitation, and it is documented here rather than
papered over.

### A3 — Malicious tenant owner

Not defended, and cannot be by this design. The owner can rewrite the registry, seed a different
API key, or change the contract. This is by construction: it is *their* money and *their*
contract. What the design does provide is **evidence** — `ignored_overrides` surfaces any attempt
to loosen a limit, and the enclave logs every decision. That makes an insider's actions visible
after the fact, not impossible.

### A4 — Hostile vendor

| Attack | Outcome |
| --- | --- |
| Return `200` with a body claiming success, no reference | `validate.ts` rejects: `cannot reconcile this payment` |
| Return `500` after actually moving money | recorded as `upstream_error` with the HTTP code and the deterministic `reference`, so it is reconcilable out of band |
| Hang | the call fails; the ledger does **not** move, so budget is not consumed by a hang |
| Return an unknown status | `validatePayoutResult` rejects unknown enums rather than defaulting to success |
| Retry-for-double-payment | `Idempotency-Key` is a deterministic function of (vendor, amount, currency, approval ref, UTC day) |

The ledger ordering — move **after** a 2xx — is what makes a hang cheap and a lie detectable.

### A5 — Hostile network

The T3N node channel is the transport; TLS and enclave attestation are T3N's guarantees, not
this project's. What this project adds is not trusting the *content*: every response crossing
back is validated (`validate.ts`), and a response that does not match the expected shape is
treated as a contract error, never as a success.

## Residual risks, ranked

1. **Agent-host compromise → forged approvals.** Real. Fix is Ed25519; the version byte is
   already there. Until then, run minting on a separate machine.
2. **Unsigned audit log.** Tamper-evident, not tamper-proof. A signed or hash-chained log (each
   entry carrying the previous entry's hash) would close it; not implemented.
3. **`check-payout` is advisory.** An agent can call `check-payout`, get `allow`, and have
   `payout` still refuse because another payout consumed the budget. Correct behaviour, but
   callers must handle it — the agent records it as a state race.
4. **No rate limiting on `check-payout`.** It is read-only and cheap, but it is unbounded. A
   compromised agent could use it as an oracle. Low impact; the enclave sees it in logs.
5. **Single currency per vendor.** The registry pins one currency per vendor; a vendor billing in
   two currencies needs two records. Deliberate, but worth knowing.
6. **Tenant-owner trust (A3).** Unavoidable. Detected, not prevented.

## What this design deliberately does not do

- **Not a custody system.** It authorises and dispatches payouts; it does not hold balances.
- **Not a KYC/AML system.** `blocked_countries` is a sanctions-ish blocklist, not compliance.
- **Not tamper-proof against its owner.** See A3.
- **Not a substitute for reconciliation.** The deterministic reference is a handle for it, not
  the thing itself.

## Verifying the claims yourself

```bash
# the MCP surface has no tool that widens a limit or mints an approval
grep -n 'name: "' agent/src/mcp.ts

# the agent has no minting path
grep -rn "mintApproval" agent/src/

# policy overrides can only tighten
cd contract && cargo test override --target x86_64-unknown-linux-gnu

# the component imports only the capabilities it uses
wasm-tools component wit contract/target/wasm32-wasip2/release/vendor_guard.wasm

# a token is bound to one exact intent
cd agent && node --test test/approval.test.ts
```
