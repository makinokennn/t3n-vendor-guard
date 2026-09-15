# Submission text — paste into the public Google Doc

This file is the submission *content*. Copy it into a Google Doc, set sharing to
**Anyone with the link → Viewer**, and put that link in the Superteam form.

Placeholders to fill before submitting: `<DID>`, `<REPO_URL>`, `<DOC_URL>`.

---

## vendor-guard — policy-gated vendor payouts on Terminal 3

**Repo:** `<REPO_URL>` (public, MIT)
**Google Doc:** `<DOC_URL>`
**DID:** `<DID>`
**Deadline met:** 2026-09-16

---

### What it is

An enterprise agent that pays vendors, where the money-moving decisions are made
by a contract inside the TEE rather than by the model.

The agent can *propose* a payout. It cannot *authorise* one. That sentence is the
whole design, and everything below exists to make it true rather than aspirational.

### The problem

Give an LLM agent a payment API and you have given a prompt injection a payment
API. The usual mitigation — a careful system prompt, a confirmation step, a
"the agent should never…" in the instructions — is not a security boundary. It is
a suggestion to a stochastic process.

So the payout authority lives in a WASM contract running inside Terminal 3's
enclave, and the agent holds no key that can reach it:

```
model  ──proposes──▶  agent (TypeScript)
                        │  policy → approval → payout → audit
                        ▼
                  contract (Rust, in the TEE)
                        │  refuses anything the policy disallows
                        ▼
                  vendor payout (one outbound call)
```

### Why this is useful and easy to maintain

**Useful.** Vendor payouts are a real, boring, recurring enterprise task with
real consequences for getting them wrong. The agent removes the copy-paste work;
the enclave removes the "the model wired the money to the wrong account" class of
incident.

**Maintainable**, which the brief calls out specifically, via four deliberate
choices:

1. **`policy.rs` is pure.** No host interface, no I/O, no clock, no network. It is
   a function from arguments to a decision. That is why the policy engine is
   unit-tested on the *host* target — 35 tests, no enclave, no tenant, no network.
   A maintainer can change a spending rule and know within seconds whether it
   broke something.
2. **The agent depends on a narrow interface.** It talks to a `ContractInvoker`,
   not to the SDK, so the gate is testable without a network and the transport can
   be swapped without touching business logic.
3. **Three binaries, split by privilege.** `vendor-guard` (the agent),
   `vendor-guard-mint` (mints approvals), `vendor-guard-admin` (owns the tenant).
   The split is not stylistic: an agent that can mint its own approvals, or
   register its own vendors, has no gate at all. Registering a vendor is what puts
   a payout URL in front of the money, so it is not exposed over MCP and not
   reachable from the agent.
4. **No build step for the agent.** Node type-strips the TypeScript directly.
   There is no bundler, no transpiler config, and no `dist/` to drift from source.

### Design decisions worth reading

**Approver identity never enters WASM memory.** The payout body carries
`{{profile.<field>}}` markers that the *host* resolves from the paying employee's
profile at dispatch time. The contract composes a request without ever holding the
human's details.

**Bank details are reduced to `bank_last4`.** The full account number is not in
the enclave's state and not in the contract's memory. A compromise of the contract
does not yield an account number, because it was never there.

**The caller cannot backdate a payout.** Day bucketing reads enclave cluster time
via `tenant_context`, not a caller-supplied timestamp. A "daily limit" that the
caller can reset by lying about the date is not a limit.

**Approval tokens are bound to the exact intent.** HMAC over
vendor + amount + currency + memo. Changing any of them invalidates the token, so
an approval cannot be redirected to a different payee or inflated after the fact.

**Policy can only tighten.** Vendor-level overrides may restrict a vendor below
the global policy but never raise it above.

### Verification

Screenshots in `docs/screenshots/` are generated from real command output by
`tools/make_screenshots.py`, so a reviewer can reproduce them:

```
contract:  cargo test --target x86_64-unknown-linux-gnu   35 passed
agent:     npx tsc --noEmit                               exit 0
agent:     node --test "test/**/*.test.ts"                42 pass / 0 fail
clippy:    cargo clippy --target wasm32-wasip2 --release   clean
component: vendor_guard.wasm  217 KB  sha256 e1876458…   (committed to the repo)
```

The capability set is checkable in one command, and we document what it actually
shows rather than what we wish it showed:

```bash
wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep import
```

Four `host:` interfaces — `tenant-context`, `logging`, `kv-store`,
`http-with-placeholders` — plus 14 `wasi:*` interfaces that the Rust toolchain
injects. That second part is not what "your import list is your capability set"
leads you to expect, and it is written up as finding 8 in `BUGS.md`.

### Docs

- `README.md` — what it is, how to verify it, the layout
- `docs/ARCHITECTURE.md` — the trust boundaries and the data flow
- `docs/THREAT-MODEL.md` — what this does *not* protect against
- `docs/SETUP.md` — zero to a real payout, including the two footguns that cost us time
- `docs/HANDOVER.md` — running it without us: day-1 checklist, what breaks first, cost
- `BUGS.md` — 8 platform findings with reproductions

### Bugs faced

Full write-up with reproductions in `BUGS.md`. Summary:

| # | Finding | Severity |
|---|---|---|
| 1 | `contract_id` is `number` in the publish result but `string` in the grant type, and `ListedContract`/`DescribeContractResult` do not expose it at all — so the only way to learn the id you need for the map ACL is to capture it from the publish call | **High** |
| 2 | Docs pin WIT host packages `2.2.0`/`1.2.0`; the actual published repo ships `2.1.0`/`1.0.0` | Medium |
| 3 | `loadConfig()` ignores `T3N_ENV` / `T3N_NODE_URL` while the CLI docs promise `T3N_ENV` works — and `setEnvironment()` mutates global state, so two call sites can disagree | Medium |
| 4 | The SDK ships fully obfuscated with no source maps, so every stack trace through it is unreadable | Medium |
| 5 | `data.camoufox.com` is NXDOMAIN, so the configured browser backend cannot install itself | Medium |
| 6 | Quickstart snippet re-declares `trustAnchor` in a way that reads as a duplicate key | Low |
| 7 | `cloud_provider: camofox` is the shipped default but its server is not started | Low |
| 8 | The compiled capability set matches neither `world.wit` nor the docs' model: wit-bindgen prunes unreferenced imports silently, and `std` injects 14 `wasi:*` interfaces (the reference contract does the same) | Medium |

Also hit, though not counted above: the Vercel Security Checkpoint on the
claim/ADK pages blocks headless browsers, which is why the claim step is manual
rather than scripted.

Two things that look like bugs and are not (documented so they are not
re-reported): the SDK's `maps.create` *does* warn when `readers` is omitted and
the KV default really is deny; and `sandbox` being an alias for `testnet` is
intended.

### Would we keep running it, or hand it over?

**Hand it over, with a documented process — and we would stay available.**

We built it so that the handover is a checklist rather than an archaeology
project, because a submission that only works in its author's head is not
maintainable. `docs/HANDOVER.md` contains the day-1 checklist, an honest
"what breaks first" list ordered by likelihood, the cost model (one outbound call
per payout), the safe way to change policy, and the three things we would add
before real money moves.

The two things that make a handover viable are both already true: the policy
engine is pure and tested without any infrastructure, and the component is
committed as a hash-verifiable artifact, so the inheritor can confirm they are
running what was reviewed before they change a line.

---

### Bonus: post for X

> Built a vendor-payout agent on @terminal3io where the money-moving logic lives
> in a WASM contract inside the TEE, not in the model.
>
> The agent can propose a payout. It cannot authorise one. Approval tokens are
> HMAC-bound to the exact vendor/amount/memo, approver identity never enters WASM
> memory, and bank details are reduced to last-4.
>
> 35 Rust tests + 42 TS tests, policy engine pure and host-free. 8 platform bugs
> written up with repros.
>
> Repo: `<REPO_URL>`
