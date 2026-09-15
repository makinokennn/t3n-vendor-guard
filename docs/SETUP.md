# Setup — from zero to a real payout

This is the long form. If you only want to *read* the design, stop after the
"Run the tests" section; everything below it needs a Terminal 3 tenant.

Three things run at three different privilege levels. Keeping them separate is
the whole point of the design, so the setup is split the same way:

| Piece | Where it runs | Who runs it | Holds |
|---|---|---|---|
| `contract/` | inside the TEE | the host | the vendor registry, the daily ledger, the vendor API key |
| `agent/` (`vendor-guard`) | next to the model | the agent runtime | its own API key, no payout authority |
| `approver` + `admin` | on a human's machine | the tenant owner | the HMAC key, the ability to register vendors |

If the agent can do everything below, the design has failed. Read
[`THREAT-MODEL.md`](THREAT-MODEL.md) before you wire this into anything real.

---

## 0. Prerequisites

```bash
rustup target add wasm32-wasip2      # Rust 1.83+ is fine
cargo install --locked wasm-tools    # or grab a release binary
node --version                       # v22.6+ (needs type-stripping); v24/26 verified
```

Node 22.6+ can run the TypeScript directly via type-stripping — there is no build
step and no bundler in this repo. Note that type-stripping does **not** support
`enum`, which is why the whole agent uses union types instead.

---

## 1. Run the tests (no tenant, no key, no network)

```bash
cd contract && cargo test --target x86_64-unknown-linux-gnu
cd ../agent && npx tsc --noEmit && node --test "test/**/*.test.ts"
```

Expected: `35 passed` for the contract, `42 pass / 0 fail` for the agent.

The contract tests run on the **host** target on purpose. `policy.rs` is a pure
function of its arguments with no host interface in scope, so it can be tested
without a WASM runtime, without an enclave, and without a tenant. That is not an
accident — it is why the policy engine is a separate module from `api.rs`.

## 2. Build the component

```bash
cd contract
cargo build --release --target wasm32-wasip2
wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep import
```

The second command is not decoration. It prints the capability set that is
*actually* in the artifact, which is not identical to what `wit/world.wit`
declares and not identical to the four `host:` interfaces you are expecting —
see [`../BUGS.md`](../BUGS.md) finding 2. Read it before you trust any claim in
this repo about what the contract can reach.

---

## 3. Claim an API key and a tenant

This part is manual and cannot be scripted — it is a Google SSO flow behind a
work-email check, which is the point.

1. Go to <https://www.terminal3.io/claim-page> and sign in with Google using a
   **work** address (consumer domains are rejected).
2. Claim the Agent Developer Kit. You get a tenant DID (`did:t3n:<hex>`).
3. Create an **agent** identity as well, distinct from the tenant. The agent must
   *not* hold the tenant key — give it its own key with its own DID and its own
   credits, so a leaked agent key cannot administer the tenant.

At the end you should have:

| Value | Env var | Notes |
|---|---|---|
| tenant DID | `AGENT_TENANT_DID` | `did:t3n:<hex>`; used to derive map names |
| agent API key | `T3N_AGENT_KEY` | the **agent's** key, not the tenant's |
| approval HMAC secret | `AGENT_APPROVAL_SECRET` | ≥ 32 bytes; generate, never reuse |
| contract tail | `AGENT_CONTRACT_TAIL` | set after publish (step 4) |

Generate the HMAC secret with something that is actually random:

```bash
openssl rand -base64 48
```

---

## 4. Publish the contract and create its maps

The two maps must exist before the first invocation, and their ACLs are the
access-control boundary — so this runs as the **tenant owner**, never as the
agent.

```bash
cd agent
npm install
export TENANT_API_KEY="<the TENANT's key — not the agent's>"

# 4a. register/publish. Capture the contract_id from the output.
node src/admin.ts register --version 0.1.0 \
  --wasm ../contract/target/wasm32-wasip2/release/vendor_guard.wasm

# 4b. create the two maps, granting read to the contract by its numeric id.
node src/admin.ts create-maps --contract-id <n-from-4a>
```

Two notes that cost us real time:

- `--contract-id` is a **number**, and it comes from the *publish result*. You
  cannot use the contract's name or tail here. `ListedContract` and
  `DescribeContractResult` do not expose the id at all, so the only reliable
  source is the register call you just made.
- The KV governor defaults an unspecified `readers` to **deny**. If you create a
  map without a reader set, it is not "private by convention" — it is unreadable,
  and the failure surfaces later as an empty read rather than an error.

`register` also records the contract tail; put that value in
`AGENT_CONTRACT_TAIL`.

## 5. Seed the vendor registry and the vendor secret

Still as the tenant owner. Registration is what puts a payout URL in front of the
money, so it is deliberately not reachable from the agent or from MCP.

```bash
node src/admin.ts add-vendor --id acme-cloud --name "Acme Cloud" \
  --currency USD --country US \
  --bank-holder "Acme Cloud Inc" --bank-last4 4242 \
  --payout-url https://api.acme.example/payout

# The vendor API key lives in the enclave and never reaches the agent.
# Read from the environment, not a flag, so the key stays out of shell history.
VENDOR_API_KEY=... node src/admin.ts seed-api-key

node src/admin.ts show      # confirm what is actually stored
```

## 6. Configure the agent

```bash
export AGENT_TENANT_DID="did:t3n:<hex>"
export AGENT_CONTRACT_TAIL="<tail-from-step-4>"
export T3N_AGENT_KEY="<agent-key>"
export AGENT_APPROVAL_SECRET="<the-secret-from-step-3>"
# export T3N_ENVIRONMENT=sandbox        # default is testnet
```

`AGENT_APPROVAL_SECRET` is present on the agent's side **only** so the agent can
*verify* a token. Minting requires the same secret, and the minting binary
(`vendor-guard-mint`) is what a human runs. See `approval.ts` for why this is an
HMAC over the intent rather than a signature over a payment.

## 7. Dry-run, then pay

```bash
node src/cli.ts policy                 # what policy does the enclave report?
node src/cli.ts check --vendor acme-cloud --amount 2500 --currency USD
```

`check` moves no money. If it passes, mint an approval as the human and pay:

```bash
node src/approver.ts --vendor acme-cloud --amount 2500 --currency USD \
  --memo "INV-2026-0042" --approver finance@example.com --ttl 900

node src/cli.ts pay --vendor acme-cloud --amount 2500 --currency USD \
  --memo "INV-2026-0042" --approval-token <token>
```

The audit trail is append-only JSONL, default `./vendor-guard-audit.jsonl`:

```bash
node src/cli.ts audit --limit 20
```

---

## 8. MCP

```bash
node src/cli.ts mcp      # JSON-RPC 2.0 over stdio, zero dependencies
```

Four tools are exposed — `policy`, `check`, `pay`, `audit`. `register` and
`set-secret` are **not** among them, by construction: a tool an agent can call to
register a vendor is a tool an agent can call to redirect a payout to itself.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| empty read from a map you just created | `readers` was not set; the default is deny |
| `refusing to send an API key to a non-TLS node URL` | `T3N_BASE_URL` is plain http and not localhost |
| `AGENT_APPROVAL_SECRET must be at least 32 bytes` | short key; the token would be forgeable |
| `T3N_AGENT_KEY is not set` | you exported the tenant key, or nothing |
| `VENDOR_API_KEY is not set` | `seed-api-key` reads the env var, not a flag |
| payout rejected with no host call made | policy denied it — run `policy` to see the effective rules |
| `AGENT_ALLOW_REVIEW` | leave it `false` unless you mean to let review-flagged payouts through |

## What is *not* covered

The end-to-end run in step 7 requires a claimed tenant, which requires a work
email and a Google account. That step is not automated in this repo and the
screenshots in the README are from a tenant that was set up by hand.
