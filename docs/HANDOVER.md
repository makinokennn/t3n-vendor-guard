# Handover: running `vendor-guard` without us

The challenge asks a specific question: *would you keep running this, or hand it
over?* This is the answer for the hand-over case, written for the person who
inherits it rather than for the person who wrote it.

## What you are inheriting

Three binaries and one component, deliberately split by privilege:

```
contract/target/wasm32-wasip2/release/vendor_guard.wasm   ← the authority
agent/src/cli.ts      (vendor-guard)      ← the agent, no authority
agent/src/approver.ts (vendor-guard-mint) ← mints approvals
agent/src/admin.ts    (vendor-guard-admin)← owns the tenant
```

The property that matters: **the agent cannot pay without a human.** Everything
else is replaceable. If you change one thing about the architecture, do not
change that one.

## Day-1 checklist

| # | Task | Time | Verify with |
|---|---|---|---|
| 1 | Rebuild the component, confirm the hash matches the README | 2 min | `sha256sum` → `e1876458…` |
| 2 | Run both test suites on your machine | 2 min | 35 + 42 pass |
| 3 | Claim your own tenant + agent key (the old ones are not transferable) | 10 min | `did:t3n:<hex>` in hand |
| 4 | Publish, create maps, register one test vendor | 15 min | `admin.ts show` lists it |
| 5 | Dry-run a payout with `check`, then pay with a minted token | 10 min | line in the audit JSONL |
| 6 | Rotate `AGENT_APPROVAL_SECRET` and re-seed the vendor key | 5 min | old tokens stop verifying |

Step 3 is the only one that cannot be scripted; it is a Google SSO flow with a
work-email check. Budget for it.

## What will break first

Honest list, ordered by how likely it is to bite you:

1. **The contract id in the map ACLs.** `create-maps` pins the maps to the
   numeric contract id from *that* publish. Re-registering allocates a fresh id
   and the old maps stay bound to the old one, so a re-publish silently leaves
   the contract unable to read its own state. The failure mode is an *empty
   read*, not an error. After any re-publish: re-run `create-maps` and check
   `admin.ts show`.
2. **`AGENT_APPROVAL_SECRET` drift.** The agent verifies with it and the approver
   mints with it. If the two sides diverge you get "invalid token" for a token
   that is perfectly valid, with no hint that the keys differ.
3. **Daily budget resets.** The ledger buckets on **UTC** days, sourced from
   enclave cluster time, not local time. A "daily" limit that resets at 07:00 for
   your finance team is working as designed; do not "fix" it without a
   conversation.
4. **Policy only tightens.** Vendor overrides can restrict a vendor below the
   global policy but never above it. Adding a generous override and being
   confused when it does not take effect is the expected behaviour, not a bug.

## Cost of running it

Per payout, the component makes exactly one outbound call (the
`http-with-placeholders` POST). Everything else (registry lookup, policy
evaluation, ledger update) is local to the enclave. So your cost scales with
payout volume, not with agent chatter. A tenant doing 200 payouts/month is
nowhere near a meaningful spend on credits.

## How to change the policy safely

`contract/src/policy.rs` is pure: no host interface, no I/O, no clock. That is
why it is testable on the host target and why you should keep it that way.

1. Edit `policy.rs`.
2. Add a case to the `#[cfg(test)]` block **that fails before your change**.
3. `cargo test --target x86_64-unknown-linux-gnu` → green.
4. Rebuild, re-publish, re-check the map ACL (see breakage #1).
5. Dry-run with `check` on a real vendor before you `pay`.

Do not move policy logic into the agent "for convenience". The agent runs next to
the model; anything in it is reachable by a prompt injection. The policy lives in
the enclave precisely so that it is not.

## Rotating the vendor key

```bash
VENDOR_API_KEY='<new-key>' node src/admin.ts seed-api-key
```

The key is read from the environment rather than a flag so it stays out of shell
history. It never leaves the enclave, so there is nothing to rotate on the
agent's side.

## If you decide to keep running it

The infrastructure you would need is small: a host for the tenant owner's
`admin`/`approver` commands (these must **not** be reachable from wherever the
agent runs), somewhere to ship the audit JSONL, and a rotation schedule for
`AGENT_APPROVAL_SECRET`. The agent itself is stateless and can run anywhere that
holds an agent key.

What you should add before real money moves, in priority order:

1. A real approval UI in front of `vendor-guard-mint`; today it is a CLI, which
   is fine for a demo and not fine for a finance team.
2. Ship the audit JSONL off-box (it is append-only and local today, so a
   compromise of the host loses it).
3. Alerting on repeated policy denials, since a spike is the signal that someone is
   probing the gate, and nothing currently surfaces it.

## Contact / provenance

Built for the Terminal 3 Agent Build Challenge, deadline 2026-09-16.
`BUGS.md` documents the platform issues hit while building this; they are
reproducible and worth reading before you spend a day on the same problems.
