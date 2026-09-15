# Bug Report — Terminal 3 (T3N) ADK

Findings collected while building `vendor-guard` against `@terminal3/t3n-sdk@5.17.0`,
the published docs (`docs.terminal3.io`), and the reference repo `z-tenant-flight`.
Environment: Linux, Node v26.7.0, npm 11.19.0, Rust/wasm32-wasip2, SDK 5.17.0.

Every entry was **reproduced**, not inferred. Commands and raw output are included
so each finding can be re-checked.

Three findings from earlier drafts were **withdrawn** after re-checking — including
one this file originally ranked Medium. They are kept at the bottom, because a bug
report is only worth reading if it says what it got wrong.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | The docs' own `invoke-contract.md` snippet does not compile (`TS1117`, duplicate key) | **High** | Confirmed |
| 2 | The compiled capability set differs from `world.wit` silently, and `std` adds 14 `wasi:*` imports | **Medium** | Confirmed |
| 3 | Docs pin WIT host packages `2.2.0`/`1.2.0`; the reference repo deliberately ships `2.1.0`/`1.0.0` | **Medium** | Confirmed |
| 4 | The SDK ships obfuscated with no source maps — which also makes static review of it unsound | **Medium** | Confirmed |
| — | `T3N_ENV` is documented but ignored by the SDK | — | **Withdrawn** — the CLI honours it; our probe was wrong |
| — | `contract_id` is `number` on register / `string` on invoke | — | **Withdrawn** — documented |
| — | Camoufox browser backend cannot install | — | **Withdrawn** — not a T3N component |

Severity rubric — calibrated to the ADK's own surface, not to a generic scale:

- **High** — a documented path fails outright for a developer who follows it
  literally (nothing works, and the failure is misattributed to their code).
- **Medium** — the path works, but the platform behaves differently from what the
  docs lead you to expect, silently or with real operational cost.
- **Low** — cosmetic or docs-only.

Only one finding reaches High, and it is the one that breaks the copy-paste path.

---

## 1. The docs' own walkthrough snippet does not compile

**Severity: High** — the copy-paste path from the official docs fails to build.

`walkthrough/invoke-contract.md` builds a client like this (lines 33–40, verbatim):

```ts
const agentClient = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"),
  wasmComponent,   // node URL resolved from setEnvironment() — see set-up-dev-env
  trustAnchor,
  handlers: {
    EthSign: metamask_sign(agentAddress, undefined, agentKey),
  },
});
```

`trustAnchor` appears **twice in the same object literal** — once as an inline
`await fetchTrustedManifest("testnet")` (line 34), once as the local `const`
declared earlier in the file (line 36). TypeScript rejects this outright:

```console
$ cat -n repro.ts
     1  // verbatim shape from walkthrough/invoke-contract.md lines 33-40
     2  interface Cfg { trustAnchor: unknown; wasmComponent: unknown; handlers: unknown; }
     3  declare function fetchTrustedManifest(e: string): Promise<unknown>;
     4  const trustAnchor = await fetchTrustedManifest("testnet");
     5  const wasmComponent = {};
     6  const agentClient: Cfg = {
     7    trustAnchor: await fetchTrustedManifest("testnet"),
     8    wasmComponent,
     9    trustAnchor,
    10    handlers: {},
    11  };
    12  export {};
$ tsc --ignoreConfig --noEmit --target es2022 --module esnext repro.ts
repro.ts(9,3): error TS1117: An object literal cannot have multiple properties with the same name.
(exit 1)
```

`TS1117` is not a style warning, it is a hard compile error. The same duplicated
shape is repeated at lines 69–72 of that file for the `userClient` literal, so
**both** clients in the walkthrough are uncopyable:

```ts
const userClient = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"),
  wasmComponent,
  trustAnchor, // same anchor as agentClient above — one environment, one manifest
  handlers: { EthSign: metamask_sign(userAddress, undefined, userKey) },
});
```

**Impact.** This is the *last* step of the walkthrough — the point at which the
developer believes everything works. The error message (`TS1117`) points at an
object literal, not at the docs, so the natural conclusion is "my code is wrong"
rather than "the example is wrong". `trustAnchor` is also *required* (omitting it
throws, and that is documented loudly), which makes a reader reluctant to delete
either occurrence — the duplication reads as load-bearing.

**Suggested fix.** Keep the local variable and drop the inline fetch:

```ts
const agentClient = new T3nClient({
  trustAnchor,                       // declared once at the top of the file
  wasmComponent,
  handlers: { EthSign: metamask_sign(agentAddress, undefined, agentKey) },
});
```

and do the same at lines 69–72. Better still, run the docs' snippets through
`tsc` in CI — this class of error is mechanical to catch.

---

## 2. The compiled capability set differs from `world.wit`, silently

**Severity: Medium** — a security-relevant invariant that does not hold as stated.

The ADK is explicit that capabilities *are* the import list, with no separate
manifest:

> Import only the host interfaces you use — they are your contract's entire
> capability set. The host refuses to load a contract that imports an interface
> its tenant world does not provide.

That framing invites a reviewer to audit `wit/world.wit` and conclude they have
seen the contract's full authority. Two things break that, in opposite directions.

### (a) An unused declared import is silently pruned from the artifact

Controlled experiment — add one import to `world.wit` that no code path calls,
then build:

```console
$ grep -c "import host:" wit/world.wit
5                                    # incl. host:interfaces/http@2.1.0 (unused on purpose)

$ cargo build --release --target wasm32-wasip2
    Finished `release` profile [optimized] target(s) in 33.35s

$ wasm-tools component wit target/wasm32-wasip2/release/*.wasm | grep "import host:"
  import host:tenant/tenant-context@1.0.0;
  import host:interfaces/logging@2.1.0;
  import host:interfaces/kv-store@2.1.0;
  import host:interfaces/http-with-placeholders@2.1.0;
```

Declared five, compiled four. No warning, no error, no note in the build log.
`wit-bindgen` drops unreferenced imports.

The pruning direction is benign here — the artifact has *less* authority than the
world file claims. But the mechanism is symmetric and silent, which is what makes
it worth reporting:

- a reviewer auditing `world.wit` **over**-counts authority, and cannot tell which
  declared imports are real;
- a typo'd interface name (`host:interfaces/kvstore@2.1.0`) fails **open in the
  reviewer's mind and closed in the artifact** — the contract simply loses the
  capability, with no diagnostic anywhere;
- the docs' statement "the host refuses to load a contract that imports an
  interface its tenant world does not provide" only covers the *extra* case. It
  says nothing about declared-but-dropped, which is the case that actually occurs.

### (b) The Rust `std` prelude adds 14 `wasi:*` imports the author never wrote

The same component also imports:

```console
$ wasm-tools component wit …/vendor_guard.wasm | grep -c 'import wasi:'
14

$ wasm-tools component wit …/vendor_guard.wasm | grep 'import wasi:'
  import wasi:io/poll@0.2.9;
  import wasi:clocks/monotonic-clock@0.2.9;
  import wasi:io/error@0.2.9;
  import wasi:io/streams@0.2.9;
  import wasi:cli/stdout@0.2.9;
  import wasi:cli/stderr@0.2.9;
  import wasi:cli/stdin@0.2.9;
  import wasi:cli/environment@0.2.9;
  import wasi:cli/exit@0.2.9;
  import wasi:cli/terminal-input@0.2.9;
  import wasi:cli/terminal-output@0.2.9;
  import wasi:cli/terminal-stdin@0.2.9;
  import wasi:cli/terminal-stdout@0.2.9;
  import wasi:cli/terminal-stderr@0.2.9;
```

`stdin`, `environment`, `exit` and the `terminal-*` family are present in a
contract that reads no stdin, takes no arguments, and returns via its exported
function. This is not specific to our crate: the reference contract
`z-tenant-flight`, with a byte-identical `[dependencies]` block, emits the same
14. The cause is that neither `Cargo.toml` sets `#![no_std]`, so `std`'s WASI
glue is linked in wholesale.

**Impact.** For a platform whose pitch is *capability-minimised execution inside a
TEE*, "your contract's entire capability set is its import list" is materially
misleading when 14 interfaces are contributed by the toolchain rather than the
author, and one author-declared import silently disappears. A reviewer comparing
the world file to a compliance checklist will get the wrong answer in both
directions. It also inflates the artifact (217 KB, of which the WASI/std glue is a
large fraction).

**Suggested fix.** Document that the **compiled component**, not the world file,
is the capability set; have the ADK CLI (or `wit-bindgen`) warn on an unreferenced
declared import; ship a `no_std` variant of the walkthrough's `Cargo.toml`; and
state in the capability docs which imports are author-controlled versus
toolchain-injected.

**Workaround used in this repo.** None for (b) — we follow the documented
`Cargo.toml` exactly, so the artifact matches the reference contract. For (a), we
keep `world.wit` to the four imports actually referenced, and the README tells the
reader to verify against the binary rather than the source:

```
wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm
```

---

## 3. Documented WIT host-package versions do not match the reference repo

**Severity: Medium** — a fresh project follows the docs into a version mismatch.

`walkthrough/write-contract.md` states, and shows in the example world:

```console
$ sed -n '42p;52,56p' developers_adk_get-started_walkthrough_write-contract.md
The packages under `wit/deps/` define the host ABI your contract links against —
vendor the versions your target cluster provides (here, `host-interfaces-2.2.0/`
and `host-tenant-1.2.0/`).
  import host:tenant/tenant-context@1.2.0;
  import host:interfaces/logging@2.2.0;
  import host:interfaces/kv-store@2.2.0;
  import host:interfaces/http@2.2.0;                    // search (no PII)
  import host:interfaces/http-with-placeholders@2.2.0;  // booking (PII via placeholders)
```

The repo the same walkthrough tells you to clone (`z-tenant-flight`) ships — and
its `world.wit` declares — something else:

```console
$ ls wit/deps/
host-interfaces-2.1.0  host-outbox-1.0.0  host-tenant-1.0.0

$ grep -E "^package|import host:" wit/world.wit
package z:tenant-flight@0.4.0;
    import host:tenant/tenant-context@1.0.0;
    import host:interfaces/logging@2.1.0;
    import host:interfaces/kv-store@2.1.0;
    import host:interfaces/http@2.1.0;                    // search (no PII)
    import host:interfaces/http-with-placeholders@2.1.0;  // booking (PII via placeholders)
```

The `2.1.0` pin is not an oversight. The vendored package says so in its own
header:

```console
$ head -5 wit/deps/host-interfaces-2.1.0/package.wit
// Held at @2.1.0 deliberately so existing contracts (user / vc /
// agent-registry / organisation / payroll), all pinned to @2.1.0
// in their per-contract wit/deps copies, continue to link against
// the host runtime. The new T3-TS-029 §6.3 / §7.1–§7.3 interfaces
// (`profile-ref`, `vp.verify`, `clock`,
```

**Impact.** The walkthrough's prose and code example contradict the repo the same
walkthrough instructs you to clone. A developer who follows the example edits
`world.wit` to `@2.2.0`, finds no `host-interfaces-2.2.0/` directory to vendor,
and — if they resolve the imports against the `2.1.0` package anyway — hits a
version mismatch that is reported by the component tooling rather than by the
docs. The correct answer (match the reference repo, whose pins are deliberate) is
discoverable only by reading a comment inside a vendored file.

**Suggested fix.** Pin the walkthrough's prose and example to the versions the
reference repo actually vendors (`host-interfaces-2.1.0`, `host-tenant-1.0.0`),
and state the rule the package comment already encodes: *the WIT package version
must match the cluster's host ABI, and the reference repo's pins are the ones the
hosted clusters serve.*

---

## 4. The SDK is published obfuscated, with no source maps

**Severity: Medium** — debuggability, and the soundness of static review.

```console
$ head -c 60 node_modules/@terminal3/t3n-sdk/dist/index.js
/* t3n-sdk-obfuscated */
'use strict';const _0x503ddc=_0x393

$ head -c 60 node_modules/@terminal3/t3n-sdk/dist/cli/index.js
#!/usr/bin/env node
/* t3n-sdk-obfuscated */
const _0x2d2fc6

$ ls node_modules/@terminal3/t3n-sdk/dist/*.map
ls: cannot access '*.map': No such file or directory
```

Every identifier is mangled (`_0x503ddc`, `_0x393e`) and no `.map` files ship.
A runtime failure therefore surfaces as a stack trace of mangled frames. The
frames do not resolve to anything a developer can read: the bundle is emitted as
a handful of very long lines, so every SDK frame in a trace points into a single
line at an enormous column offset. Reproduced:

```console
$ node -e 'import("@terminal3/t3n-sdk").then(({T3nClient})=>new T3nClient({}))'
T3nConfigError: T3nClient: `trustAnchor` is required and must be either a
TrustAnchor ({ expected_peer_ids, rtmr3_allowlist, rtmr1_allowlist }) ...
    at new T3nClient (file:///.../t3n-sdk/dist/index.esm.js:2:456604)
    at file:///.../errtest.mjs:6:13
```

To be fair to the platform: the *error messages* are unusually good, and the
error classes are named. The problem is purely the frame — `index.esm.js:2:456604`
is line 2, column 456604, which tells a developer nothing about which part of the
SDK failed or why.

**The consequence worth reporting is not just readability.** The obfuscator also
encodes string literals into a lookup table, so *static inspection returns false
negatives*. Verifying this against our own draft findings:

```console
$ grep -c "T3N_ENV" node_modules/@terminal3/t3n-sdk/dist/cli/index.js
0                                   # reported as "the string does not exist"

$ T3N_ENV=production t3n did get did:t3n:0123…4567
error: fetch failed                  # …yet the CLI demonstrably honours it:
                                     # it switched off testnet and tried production
```

The string is absent from the file's text but present in behaviour. This is a
trap for exactly the reviewer the ADK wants — someone auditing the client to
understand what it does — and it is what caused a wrong finding in an earlier
draft of this report (see W1). It also matters for security review: *"the
dangerous string does not appear in the bundle"* is not a sound conclusion
against this artifact.

**Impact.** Any error originating inside the SDK is effectively undebuggable, and
any negative claim derived from reading the bundle is unsound. Note that the
*type* declarations are clean and extensively documented — the degradation is
purely at runtime, which makes the gap more surprising, not less.

**Suggested fix.** Ship source maps (or an unobfuscated `dist/`) and point
`package.json` at them. Obfuscation buys little here: this is a client for a
public API, and the protocol surface is already public in the docs.

---

## Withdrawn findings

Kept on the record so they are not re-reported, and because a report that only
lists hits is not evidence of method.

### W1. `T3N_ENV` is documented but ignored by the SDK — *withdrawn*

An earlier draft ranked this **Medium**. It rests on a probe that was itself
unsound, and it is the direct consequence of finding 4.

The draft's evidence was a grep:

```console
$ grep -c "T3N_ENV" node_modules/@terminal3/t3n-sdk/dist/index.js
0
```

…plus a `loadConfig()` call that stayed on testnet. Both are explained without a
platform bug:

- The documented sentence lives in `developers/agents/register-agent.md` and
  `provision-org-agent.md`, under the heading **"Register a Public Agent"**, and
  reads *"All commands that talk to the network accept `--env …` (or the `T3N_ENV`
  environment variable)"*. That is about the **CLI**, not `loadConfig()`.
- The CLI does honour it. Run against a public command with no credentials:

  ```console
  $ t3n did get did:t3n:0123…4567 --env testnet
  id: did:t3n:0123…4567
  agent: (none)

  $ T3N_ENV=production t3n did get did:t3n:0123…4567
  error: fetch failed
  ```

  The environment variable changes which cluster the CLI talks to. The grep
  returned `0` only because the obfuscator stores string literals in an encoded
  table (finding 4) — a false negative, not evidence of absence.

The residual point is narrower and is folded into finding 4: the *SDK's*
`loadConfig()` does not read environment variables, but nothing in the docs claims
it does. The draft generalised a CLI statement to the library and then "confirmed"
it with a grep that cannot be trusted against this artifact.

### W2. `contract_id` is `number` on register and `string` on invoke — *withdrawn*

An earlier draft ranked this **High**. It does not survive scrutiny.

The types are real and still disagree:

```console
$ grep -nE "^[[:space:]]+contract_id:" index.d.ts
  1217:    contract_id: string;
  1378:    contract_id: string;
  1420:    contract_id: string;
  1439:    contract_id: string;
  1480:    contract_id: string;
  1780:    contract_id: string;
  4556:    contract_id: string;    # InvokeRequest
  6487:    contract_id: number;    # ContractRegisterResult — the only numeric one
```

But the two fields are not the same identifier, and the docs say so plainly:

- `InvokeRequest.contract_id` is the **canonical contract name**. The walkthrough
  states: *"the `contract_id` starts with `z:<tid>:`"*, and every example passes
  `TENANT_CONTRACT` — i.e. `z:<tid>:travel-contracts`. Its type is `string`
  because a name is a string.
- `ContractRegisterResult.contract_id` is the **numeric ACL identifier**, described
  in its own doc comment as *"Stable monotonic numeric contract id assigned at
  registration time"*.

So the type difference reflects two different concepts sharing one field name —
confusing, but not an inconsistency that misleads a compiler or a reader who has
read the docs. `invoke()` cannot accept the numeric ID at all, which makes the
mistake the draft feared (`feeding the numeric id into invoke()`) impossible to
write without a type error.

The other half of the draft's claim — that the numeric ID is unrecoverable from
the read APIs — is **documented behaviour**, and the docs warn about it
explicitly:

> **Re-registering a tail allocates a new `contract_id`.** … there is currently
> no API to fetch a tail's current `contract_id` after re-registering, so if you
> created map ACLs scoped to the old `contract_id`, a re-registration can leave
> them pointing at a stale id. Keep a record of each `contract_id` your tenant
> registers so you can re-grant map access if needed.

That is a documented limitation with a documented workaround — the same workaround
this repo implements in `admin.ts` (thread the ID from `register` to
`create-maps --contract-id`). Calling it a bug would be wrong.

Verified as *not* recoverable, for completeness — `ListedContract` and
`DetailedContract` (via `listDetailed`) both omit the field, and
`DescribeContractResult` carries only `{contract, version, descriptor}`. The
docs' warning is accurate.

### W3. The Camoufox browser backend cannot install — *withdrawn*

An earlier draft reported this as a T3N finding at Medium severity. It is not a
T3N component at all:

```console
$ grep -rin "camoufox\|camofox" /tmp/t3ndocs/*.md
(no output)
```

The string appears nowhere in the ADK documentation. Camoufox is a local browser
backend configured in this machine's own tooling, and the failure
(`data.camoufox.com` is NXDOMAIN) is a problem with that tooling's upstream
dependency. Reporting it against the ADK was a category error — the draft mistook
"a thing that went wrong while I was building" for "a thing wrong with the
product".

The related note about `cloud_provider: camofox` being a broken default is
withdrawn for the same reason: it describes a local config file, not the ADK.

---

## Note: two more things that look like bugs but are not

- **`sandbox` and `testnet` resolve to the same node URL.** Intentional and
  documented: *"`sandbox` and `testnet` are the same test network."*
- **`maps.create()` without `readers` yields a deny-all map.** A documented
  footgun, not a defect — `MapCreateInput.readers` carries an explicit warning
  that omission defaults to deny-all, the SDK emits a `console.warn` when it is
  omitted, and the KV-map docs call it out. Our contract sets
  `readers: { only: [contractId] }` explicitly.
