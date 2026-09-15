# Architecture

How a payout actually flows, and where each guarantee is enforced.

## The call path

```
vendor-guard pay --vendor acme-cloud --amount 12500 --currency USD --approval-token vg1.…
  │
  ├─ 1. loadConfig()          env validated; every problem reported at once
  ├─ 2. PaymentGate.pay()
  │     │
  │     ├─ 3. contract.check-payout ────────────────▶ TEE
  │     │        policy.rs evaluates:                 │  reads z:<tid>:state
  │     │          vendor known + active?             │    (registry + daily ledger)
  │     │          country not blocked?               │
  │     │          currency allowed + matches vendor? │
  │     │          amount > 0, <= single cap?         │
  │     │          daily_spent + amount <= daily cap? │
  │     │          memo present if amount >= threshold?
  │     │        → allow | review | deny              │
  │     │◀───────────────────────────────────────────┘
  │     │
  │     ├─ 4. decision == deny ?  ──▶ audit("refused")  ──▶ return. Bank never called.
  │     ├─ 5. decision == review && !allowReview ? ──▶ audit("refused")  ──▶ return.
  │     │
  │     ├─ 6. verifyApproval(secret, token, intent)
  │     │        MAC (constant-time) → version → binding → expiry → nonce
  │     │        any failure ──▶ audit("refused")  ──▶ return. Bank never called.
  │     │
  │     ├─ 7. contract.payout ──────────────────────▶ TEE
  │     │        RE-EVALUATES policy from scratch      │  reads z:<tid>:secrets
  │     │        (check→payout race is a deny)         │  POST vendor API w/ key
  │     │        egress via http-with-placeholders     │  {{profile.*}} resolved
  │     │        ledger moves only after 2xx           │    by the HOST
  │     │◀───────────────────────────────────────────┘
  │     │
  │     ├─ 8. validatePayoutResult()   malformed response ──▶ contract error
  │     └─ 9. audit("paid" | "refused" | "upstream_error")  ──▶ return
```

Three properties fall out of this ordering:

1. **Nothing reaches the bank until policy *and* approval both pass.** Steps 4, 5 and 6 all
   return before step 7.
2. **The enclave re-decides at payout time.** Step 3 is advisory; step 7 is authoritative.
3. **The audit entry is written before the caller sees the outcome.** A crash between step 7 and
   step 9 leaves a record that the attempt happened.

## Where each secret lives

| Secret | Held by | Readable by the agent? |
| --- | --- | --- |
| Vendor API key | `z:<tid>:secrets` in the TEE | **No**: used in-enclave, never returned |
| Approver's name/email | the host, resolved from the paying user's profile | **No**: the contract authors `{{profile.*}}` and the host substitutes at dispatch |
| Full bank account | nowhere in this system | **No**: the registry stores `bank_last4` only |
| Approval HMAC secret | agent process + finance machine | Yes (documented limitation, see THREAT-MODEL) |
| Tenant API key | the human operator | **No**: the agent gets its *own* key with its *own* credits |

## The approval token

```
vg1 . base64url(payload) . base64url(HMAC-SHA256(secret, payload))
```

`payload` is newline-joined so that a field containing the separator cannot forge structure:

```
v1
acme-cloud
12500
USD
<memoHash = SHA-256(trimmed memo), or the hash of the empty string>
finance@example.com
<nonce: 16 random bytes, hex>
<issuedAt: epoch secs>
<expiresAt: epoch secs>
```

Verification order, and why it is this order:

1. **MAC first, then parse.** Never parse attacker-controlled structure before authenticating
   it. `timingSafeEqual` for the comparison, because a length-mismatch fast path would leak the MAC
   length and make forgery measurable.
2. **Then version**, so a future token format is rejected loudly rather than misread.
3. **Then binding**: vendor, amount, currency and memo must equal the intent being paid. This is
   the step that makes a token non-transferable.
4. **Then time**: expiry, and a lifetime ceiling so a "valid for a year" token is refused.
5. **Then nonce**, checked against the spent-nonce set built from the audit log.

`memoHash` compares `SHA-256(trimmed)` rather than the raw string, so `"INV-1"`, `" INV-1 "` and
`"INV-1\n"` are the same approval, while `"INV-2"` is not.

## Why the audit log is the nonce store

Replay protection needs durable state, and a payment agent already needs a durable record. Rather
than a second store that can drift out of sync with the log, the spent nonces *are* the log's
`paid` entries. One source of truth, and the replay check is derived from the same data an
auditor reads.

The log is append-only JSONL. Entries carry `ts`, `event`, `intent`, `decision`, `reasons`,
`reference`, `nonce`, `approver` and a free-text `detail`.

## The TEE boundary

```
contract/wit/world.wit
  import host:tenant/tenant-context@1.0.0        cluster-timestamp-secs (never the caller's clock)
  import host:interfaces/logging@2.1.0
  import host:interfaces/kv-store@2.1.0          z:<tid>:state, z:<tid>:secrets
  import host:interfaces/http-with-placeholders@2.1.0
  export z:vendor-guard/contracts@0.1.0          get-policy, check-payout, payout
```

Two consequences of using the host interfaces rather than rolling our own:

- **Time comes from the enclave** (`cluster-timestamp-secs`), not the request. A caller cannot
  backdate a payout to land it in yesterday's spent budget.
- **The outbound HTTP call is a template, not a request.** The contract writes
  `{{profile.verified_contacts.email.value}}`; the host resolves it from the paying user's profile
  and enforces egress grants. The contract never handles the approver's identity, and an
  un-granted host fails with `egress_denied` rather than silently succeeding.

`http-with-placeholders` is imported and `http` is not: the component's imports are exactly the
capabilities it uses. You can verify this yourself:

```bash
wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm
```

## Trust boundaries

```
  ┌─ untrusted ────────────────────────────────┐
  │  the model's output, the request payload,  │
  │  the vendor's HTTP response                │
  └────────────────┬───────────────────────────┘
                   │ validated at: parseArgs, validateCheckResult,
                   │ validatePayoutResult, verifyApproval, policy.rs
  ┌────────────────▼───────────────────────────┐
  │  trusted-ish: the agent host               │  ← a compromise here is game over
  │  (holds the approval secret, runs the gate)│     see THREAT-MODEL.md
  └────────────────┬───────────────────────────┘
                   │ attested, encrypted channel
  ┌────────────────▼───────────────────────────┐
  │  trusted: the TEE                          │
  │  policy, registry, ledger, API key         │
  └────────────────────────────────────────────┘
```

Every arrow crossing downward is a validation point with a test behind it. The `agent host` row
is the honest weak link, and the design is explicit about it rather than pretending otherwise.
