# vendor-guard

**A spending-policy enclave for autonomous payment agents, built on Terminal 3.**

An LLM agent that can move money is only as safe as the policy in front of it. `vendor-guard`
puts that policy *inside a TEE* — a Rust/WASM contract running on Terminal 3 — so that the
limits, the vendor registry, the daily spend ledger and the vendor's API key all live in a
place the agent can call but cannot read, edit or route around.

The agent gets four tools. It can look up the policy, dry-run an intent, ask for a payout, and
read its own audit log. It cannot widen a limit, register a vendor, or authorise its own
payment.

```
                       ┌──────────────────────────────────────────────┐
   LLM agent           │  Terminal 3 enclave (TDX)                    │
  ┌──────────┐         │                                              │
  │  Claude  │  MCP    │  vendor-guard contract (Rust → wasm32-wasip2) │
  │  GPT     │────────▶│                                              │
  │  …       │  tools  │   policy ─┐                                  │
  └──────────┘         │   vendors ├─ z:<tid>:state    (KV)           │
   ▲                   │   ledger ─┘                                  │
   │                   │   API key ── z:<tid>:secrets  (KV)           │
   │  approval token   │                                              │
   │  (human-minted)   │   http-with-placeholders ──▶ vendor API      │
  ┌──────────┐         │      └── {{profile.*}} resolved by the HOST   │
  │ Finance  │────────▶│          the contract never sees them        │
  │  human   │  CLI    │                                              │
  └──────────┘         └──────────────────────────────────────────────┘
```

---

## Why this is not just "an if-statement in the agent"

A policy the agent enforces is a policy the agent can be talked out of. Everything below is a
property of *where the code runs*, not of how carefully the prompt is written.

| Failure mode | What happens here |
| --- | --- |
| Prompt injection tells the agent to pay a new vendor | The vendor is not in `z:<tid>:state`. Denied inside the enclave. |
| Agent splits a large payment to dodge the cap | The daily ledger is cumulative and lives in the enclave. Split payments still sum. |
| Agent retries a payment after a timeout | Deterministic `idempotency_key` per (vendor, amount, currency, approval ref, UTC day). |
| Agent is asked for the vendor's API key | The key is read from `z:<tid>:secrets` inside the TEE and used in-enclave. It is never returned. |
| Agent edits the policy to raise a limit | `tightened_with()` refuses any override that would loosen a limit and reports it in `ignored_overrides`. |
| Agent pays a blocked jurisdiction | `blocked_countries` is checked against the vendor record in the enclave. |
| Agent invents its own approval | It holds no signing key. Approval tokens are minted by a **separate binary** (`vendor-guard-mint`). |
| Agent leaks the approver's identity | The contract authors `{{profile.*}}` placeholders; the **host** resolves them at dispatch. |
| Agent quietly drops a refusal | Every check, refusal, rejection and payment is appended to a local audit log *before* the caller sees the result. |

---

## The three capabilities, and why they are three

The security argument rests on this split. A single binary that can both *request* and
*authorise* a payment is not a control, it is a formality.

| Binary | Can do | Cannot do |
| --- | --- | --- |
| `vendor-guard` (agent) | check intents, execute approved payouts, read policy + audit | mint approvals, edit policy, register vendors |
| `vendor-guard-mint` (human) | mint an approval token bound to one exact intent | move money |
| `vendor-guard-admin` (human) | seed the vendor registry | move money |

The agent's MCP tool list is deliberately small for the same reason. There is no
`mint_approval` tool and no `set_policy` tool. Those do not exist on the agent's surface at all,
so no amount of prompt injection can reach them.

---

## Approval tokens: binding a payment to a human

The agent cannot pay without a token that only a human can produce.

```
vg1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>

payload = v1\n<vendor>\n<amount>\n<currency>\n<memoHash>\n<approver>\n<nonce>\n<issuedAt>\n<expiresAt>
```

Properties, each covered by a test in `agent/test/approval.test.ts`:

- **Bound to one intent.** Change the amount, vendor, currency or memo and the token stops
  verifying. A token for $100 cannot become a token for $100,000 — not by editing it, and not
  by pointing it at a different vendor.
- **Single use.** The nonce is spent in the audit log; replaying the token is refused *and the
  bank is never called*.
- **Time-boxed.** Expiry is enforced, and a token whose lifetime exceeds
  `AGENT_MAX_APPROVAL_TTL_SECS` (default 900s) is rejected even if still valid — so a
  long-lived "standing approval" cannot be smuggled in.
- **Fail-closed.** Malformed, truncated, wrong-version and wrong-secret tokens all deny with a
  specific reason. There is no code path where a parse failure becomes an allow.

> **Known limitation, stated plainly.** Today the agent verifies the token, which means the
> agent holds the HMAC key and a compromised agent host could in principle mint. This is why
> `approver.ts` is a separate binary and why the split is documented as the seam to upgrade:
> swap HMAC for Ed25519 and the agent holds only a public key. See
> [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for the full analysis — including the parts
> this design does *not* protect against.

---

## What runs inside the enclave

`contract/` — Rust, compiled to `wasm32-wasip2`, published to T3N as `z:<tid>:vendor-guard`.

| Export | Purpose |
| --- | --- |
| `get-policy` | Effective policy + vendor registry + any refused overrides. Read-only. |
| `check-payout` | Evaluate an intent. Moves no money, consumes no budget. |
| `payout` | Re-evaluate, then call the vendor and update the ledger. |

`payout` **re-evaluates policy from scratch** rather than trusting an earlier `check-payout`.
Between the two calls another payout may have consumed the day's budget; the contract treats
that as a state race and refuses, which the agent records as `policy state changed between
check and payout`.

### The policy engine

Pure, dependency-free, and unit-testable on the host target — `policy.rs` imports no T3N host
interface, which is what lets the entire decision surface be tested without a cluster.

```rust
pub struct Policy {
    pub max_single_payout: u64,      // minor units
    pub max_daily_total: u64,        // cumulative per UTC day
    pub allowed_currencies: Vec<String>,
    pub require_memo_over: u64,
    pub blocked_countries: Vec<String>,
}
```

Rules produce one of three decisions — `allow`, `review`, `deny` — and **every** failing rule is
reported, not just the first, so an operator sees the whole picture in one round trip. A single
`deny` always outranks any `review` signal. Reason codes are stable strings
(`vendor_unknown`, `daily_cap_exceeded`, `memo_required`, `currency_mismatch`, …) so the agent
can reason about them programmatically instead of pattern-matching prose.

Two details that matter more than they look:

- The daily ledger is accumulated with `saturating_add`, so a hostile or corrupt ledger value
  cannot wrap the counter around to zero and unlock the cap.
- The ledger moves **after** the vendor accepts. Counting first would burn budget on failed
  attempts; never counting would make the cap decorative.

### Where the money secrets live

The vendor's API key is read inside the enclave from `z:<tid>:secrets` and used in-enclave:

```rust
let api_key = store::read_vendor_api_key()?;   // never returned to the caller
```

There is no export that returns it. `get-policy` returns only `bank_last4`, never a full account
number.

---

## Quickstart

```bash
git clone https://github.com/<you>/vendor-guard && cd vendor-guard

# 1. Contract: build + test
cd contract
cargo test --target x86_64-unknown-linux-gnu   # 35 tests, host target
cargo build --release --target wasm32-wasip2   # → target/wasm32-wasip2/release/vendor_guard.wasm

# 2. Agent: test + typecheck
cd ../agent
npm install
npm test          # 42 tests, no network
npm run typecheck
```

Expected output:

```
contract:  test result: ok. 35 passed; 0 failed
agent:     ℹ tests 42   ℹ pass 42   ℹ fail 0
wasm:      vendor_guard.wasm  217 KB   sha256 e1876458…
```

Then publish and run for real: [`docs/SETUP.md`](docs/SETUP.md).

### Evidence

Every image in [`docs/screenshots/`](docs/screenshots) is a real command's output,
rendered by [`tools/make_screenshots.py`](tools/make_screenshots.py) — re-run it
and you get the same pictures from your own machine.

| | |
|---|---|
| [Contract tests](docs/screenshots/01-contract-tests.png) | 35 tests, host target, no enclave |
| [Agent typecheck + tests](docs/screenshots/02-agent-typecheck-and-tests.png) | `tsc --noEmit` clean, 42 pass |
| [Capability set](docs/screenshots/03-capability-set.png) | what the artifact *actually* imports (BUGS.md #3) |
| [Artifact hash](docs/screenshots/04-artifact-hash.png) | the committed component, hash-verifiable |
| [Agent CLI](docs/screenshots/05-agent-cli.png) | 4 commands; only `pay` moves money |
| [Admin CLI](docs/screenshots/06-admin-cli.png) | the tenant owner's separate binary |
| [Approver CLI](docs/screenshots/07-approver-cli.png) | minting is not reachable by the agent |
| [Finding 1 evidence](docs/screenshots/08-bug1-docs-snippet-ts1117.png) | the docs' snippet fails to compile (TS1117) |
| [Finding 2 evidence](docs/screenshots/09-finding2-import-pruning.png) | declared 5 host imports, compiled 4, no warning |
| [Finding 4 evidence](docs/screenshots/10-finding4-obfuscation.png) | obfuscated bundle, no `.map` |
| [Withdrawn finding](docs/screenshots/11-withdrawn-cli-honours-env.png) | the probe we retracted, and why |
| [ADK claim page](docs/screenshots/12-adk-claim-page.png) | the sandbox landing page, reached without a checkpoint |
| [Claim form + SSO](docs/screenshots/13-claim-form-sso.png) | the Google-gated claim form: the one step that is manual |

The last two are the step that cannot be scripted. The form is behind Google
Sign-In with a work-email check, so claiming a tenant is a human action by
design — see `docs/SETUP.md` step 3.

### Check the capability set yourself

A contract's capabilities *are* its import list — there is no separate manifest. The
list in `wit/world.wit` is what we ask for; the compiled component is what we actually
get, because `wit-bindgen` prunes an import no code path references:

```bash
wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep 'import'
```

Four `host:` interfaces, all deliberate: `tenant-context` (map naming), `logging`,
`kv-store` (registry + secrets), `http-with-placeholders` (the payout).

The component also imports 14 `wasi:*` interfaces (`cli`, `io`, `clocks`). Those are
**not** ours — they come from the Rust `std` prelude, and the reference contract
`z-tenant-flight` (same `Cargo.toml`) emits the identical set. If you want to drop
them, the crate has to become `#![no_std]` with its own panic handler; the ADK
walkthrough does not ask for that. We are flagging it rather than hiding it, because
"we import only what we use" is a claim a reviewer should be able to falsify in one
command — and strictly speaking, for the `wasi:*` block, it is false.

---

## Usage

### As an MCP server (the agent's view)

```bash
export AGENT_CONTRACT_TAIL=vendor-guard
export AGENT_TENANT_DID=did:t3n:<your-tenant-hex>
export AGENT_APPROVAL_SECRET=<32+ random bytes>
export T3N_AGENT_KEY=<the AGENT's own key — not your tenant key>

vendor-guard mcp
```

Claude Desktop / Cursor / any MCP client:

```json
{
  "mcpServers": {
    "vendor-guard": {
      "command": "vendor-guard",
      "args": ["mcp"],
      "env": {
        "AGENT_CONTRACT_TAIL": "vendor-guard",
        "AGENT_TENANT_DID": "did:t3n:<your-tenant-hex>",
        "AGENT_APPROVAL_SECRET": "<32+ random bytes>",
        "T3N_AGENT_KEY": "<agent key>"
      }
    }
  }
}
```

The model sees exactly four tools: `get_policy`, `check_payout`, `pay_vendor`, `audit_tail`.

### From the terminal

```bash
vendor-guard policy
vendor-guard check --vendor acme-cloud --amount 12500 --currency USD --memo "INV-2026-0042"
vendor-guard pay   --vendor acme-cloud --amount 12500 --currency USD \
                   --memo "INV-2026-0042" --approval-token vg1.…
vendor-guard audit --limit 20
```

A refused payout exits non-zero and prints the structured reason — usable directly in CI:

```console
$ vendor-guard pay --vendor acme-cloud --amount 90000000 --currency USD \
                   --memo "urgent" --approval-token vg1.…
{
  "status": "refused",
  "reasons": [{ "code": "amount_exceeds_single_cap",
                "detail": "90000000 exceeds the single-payout cap of 250000" }]
}
```

### The human side

```bash
export AGENT_APPROVAL_SECRET=<same secret, on the finance machine>

# read the effective policy
vendor-guard policy

# authorise one specific payment
vendor-guard-mint --vendor acme-cloud --amount 12500 --currency USD \
                  --memo "INV-2026-0042" --approver finance@example.com
# → vg1.eyJ2Ijo…  (hand this to the agent; it is a bearer cheque for one payment)

# seed the vendor registry
vendor-guard-admin add-vendor --id acme-cloud --name "Acme Cloud" \
  --currency USD --country US --payout-url https://api.acme.example/v1/payouts \
  --bank-last4 4242 --active
```

---

## Layout

```
contract/                  Rust → WASM, runs inside the TEE
  wit/world.wit            the ABI: 3 exports, 4 host imports
  wit/deps/                pinned host interface packages (2.1.0 / 1.0.0)
  src/policy.rs            pure policy engine — no host interface, fully unit-testable
  src/api.rs               the 3 entry points; egress via http-with-placeholders
  src/store.rs             KV access: registry, daily ledger, secrets
  src/dates.rs             UTC day bucketing, dependency-free

agent/                     TypeScript, runs next to the model
  src/mcp.ts               MCP server (4 tools), hand-rolled JSON-RPC — auditable in one file
  src/gate.ts              the payment gate: policy → approval → payout → audit
  src/approval.ts          token mint/verify (HMAC-SHA256, constant-time compare)
  src/invoker.ts           the only file that touches the T3N SDK
  src/validate.ts          response validation — a malformed response is never "paid"
  src/audit.ts             append-only log + nonce store
  src/cli.ts               agent CLI (no mint, no admin)
  src/approver.ts          human-only: mint approval tokens
  test/                    42 tests, no network, no cluster

docs/                      SETUP · ARCHITECTURE · THREAT-MODEL
BUGS.md                    findings from building against the T3N ADK
```

---

## Design decisions worth arguing about

**The MCP server is hand-rolled, not a framework.** The MCP surface *is* the agent's authority.
Reading it in full, in one file, is how a reviewer confirms that `pay_vendor` demands an approval
token and that no tool widens a limit. A framework would hide exactly the part worth auditing.
It also keeps the agent's dependency surface at exactly one package — which matters for
something that runs unattended next to money.

**`invoke()` instead of a `T3nClient` session.** A payment agent runs on a schedule, in a
container, and often only when an invoice arrives. A stateless `{baseUrl, apiKey, request}` call
means no session to expire, no handshake to retry, and no long-lived authenticated object sitting
in a process that mostly sleeps.

**Amounts are integers in minor units, always.** `--amount 12.50` is rejected rather than
coerced. Silently interpreting a decimal is exactly the bug that turns a $12.50 invoice into a
$1,250 transfer.

**Refusals are results, not errors.** A policy denial comes back as a normal tool result with
reason codes. The model should be able to read *why* and explain itself to the operator — and an
error-shaped refusal invites the model to retry, which is the wrong instinct.

**Response validation is its own module.** The contract is our own code, but its response crosses
a network. A payout that claims `status: "paid"` without a reference is rejected outright —
`cannot reconcile this payment` — because an unreconcilable "success" is worse than a failure.

---

## Testing

```bash
cd contract && cargo test --target x86_64-unknown-linux-gnu   # 35 tests
cd agent && npm test                                          # 42 tests
```

The tests are the specification. A representative slice:

| Test | Property |
| --- | --- |
| `daily_cap_uses_saturating_add_so_a_hostile_ledger_cannot_wrap` | a corrupt ledger cannot unlock the cap |
| `every_failing_rule_is_reported_not_just_the_first` | operators see all violations at once |
| `a_deny_always_outranks_a_review_signal` | review cannot soften a hard denial |
| `the same approval token cannot be used twice` | replay is refused *and* payout is never called |
| `a token minted for one amount cannot be replayed for another` | tokens are intent-bound |
| `editing the memo invalidates the approval` | memo is inside the MAC |
| `a denied intent never reaches the payout function` | policy failures cannot leak into a bank call |
| `a contract refusal at payout time is logged as a state race, not a success` | check→payout races surface |
| `a payout claiming success without a reference is refused` | unreconcilable success is rejected |
| `an unknown decision is rejected rather than treated as allow` | fail-closed on unknown enums |
| `reports every problem at once instead of one at a time` | config errors are actionable |

---

## Threat model

Full analysis in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), including the attacks this
design does **not** stop: a fully compromised agent host, a malicious tenant owner (who can
always rewrite the registry), and upstream vendor compromise. Written to be read by someone
deciding whether to trust it with real money — not to be flattering.

## License

MIT — see [LICENSE](LICENSE).
