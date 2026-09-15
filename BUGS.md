# Bug Report — Terminal 3 (T3N) ADK

Findings collected while building `vendor-guard` against `@terminal3/t3n-sdk@5.17.0`,
the published docs (`docs.terminal3.io`), and the ADK browser tooling.

Every entry below was **reproduced**, not inferred. Commands and raw output are
included so each finding can be re-checked. Environment: Linux, Node v26.7.0,
npm 11.19.0, SDK 5.17.0.

Severity is judged by *blast radius on a developer who follows the docs*:

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `contract_id` is `number` on register, `string` on invoke — and absent from every read API | **High** | Confirmed |
| 2 | Docs pin WIT host packages `2.2.0`/`1.2.0`; the actual published repo ships `2.1.0`/`1.0.0` | **Medium** | Confirmed |
| 3 | `loadConfig()` ignores `T3N_ENV` / `T3N_NODE_URL` while the CLI docs promise `T3N_ENV` works | **Medium** | Confirmed |
| 4 | SDK ships fully obfuscated with **no source maps** — stack traces are unreadable | **Medium** | Confirmed |
| 5 | `data.camoufox.com` is NXDOMAIN, so the configured browser backend cannot install | **Medium** | Confirmed |
| 6 | Quickstart snippet re-declares `trustAnchor` in a way that reads as a duplicate key | **Low** | Confirmed |
| 7 | `cloud_provider: camofox` is the shipped default, but its server is not started | **Low** | Confirmed |
| 8 | The compiled capability set matches neither the `world.wit` nor the docs' mental model | **Medium** | Confirmed |

---

## 1. `contract_id` changes type between the write path and the read path — and the read path omits it entirely

**Severity: High.** This is the one that actually cost real time.

Setting a KV map's access control list requires the contract's numeric ID. The
SDK gives you that ID on exactly one call, in a different type than the field
that consumes it, and then never exposes it again.

### Evidence — the three shapes disagree

```console
$ cd node_modules/@terminal3/t3n-sdk/dist && grep -n "interface InvokeRequest" -A3 index.d.ts
interface InvokeRequest {
    contract_id: string;      // ← line 4556  STRING
    contract_version: string;
    function_name: string;

$ grep -n "interface ContractRegisterResult" -A6 index.d.ts
interface ContractRegisterResult {
    ...
    contract_id: number;      // ← line 6487  NUMBER

$ grep -n "^type WriterSet" -A3 index.d.ts
type WriterSet = "all" | {
    only: number[];           // ← line 6385  NUMBER[]
};
```

So: `register()` hands back a `number`, `invoke()` takes a `string`, and the ACL
setter takes `number[]`. A developer who writes
`readers: { only: [String(result.contract_id)] }` gets a type error; one who
writes `readers: { only: [result.contract_id] }` and then feeds that same value
into `invoke()` gets a different type error. The value must be carried as a
`number` and stringified only at the `invoke` boundary — nothing says so.

### Evidence — the read APIs drop the field

The two obvious ways to *recover* the ID both fail:

```console
$ grep -n "interface ListedContract" -A16 index.d.ts
interface ListedContract {
    name: string;            // z:<tid>:<tail>
    kind: ContractKind;
    version: string | null;
    summary: string;
    tags: string[];
    owner_org_did?: string;
    short_name: string;
}                            // ← no contract_id anywhere

$ grep -n "interface DescribeContractResult" -A8 index.d.ts
interface DescribeContractResult {
    contract: string;
    version: string;
    descriptor: ContractDescriptorDocument;
}                            // ← no contract_id either
```

**Impact.** `contracts.list()` and `describe()` are the natural recovery paths —
you call them to re-derive state you lost. Neither returns `contract_id`. If a
developer discards the `register()` result (very easy: it is a one-shot side
effect, often run from a script), the numeric ID is **unrecoverable through the
public SDK**, and the maps they already created stay locked because
`WriterSet.only` / `ReaderSet.only` only accept that number.

**Reproduction.** Any `register` → `create-maps` → (process restart) → attempt to
grant a second contract read access. The grant needs an ID that no read API
returns.

**Suggested fix.** Either (a) add `contract_id: number` to `ListedContract` and
`DescribeContractResult`, or (b) accept the canonical string name
(`z:<tid>:<tail>`) in `WriterSet.only` / `ReaderSet.only` and resolve it
server-side. (b) matches how every *other* field in the SDK identifies a
contract and would remove the string/number split entirely.

### Workaround used in this repo

`agent/src/admin.ts` never loses the value: `register` captures
`ContractRegisterResult.contract_id` and prints it, and `create-maps` takes it as
a required `--contract-id <n>` argument, so the numeric ID is threaded explicitly
from the one call that produces it to the one call that consumes it.

---

## 2. Documented WIT host-package versions do not match the published repo

**Severity: Medium** — a fresh project fails to build against the docs.

The write-contract walkthrough states:

```console
$ grep -n "host-interfaces\|host-tenant" /tmp/t3ndocs/*write-contract*.md
42:The packages under `wit/deps/` define the host ABI your contract links against —
   vendor the versions your target cluster provides (here, `host-interfaces-2.2.0/`
   and `host-tenant-1.2.0/`).
```

But the reference repository (`z-tenant-flight`) and every working example vendor:

```console
$ ls wit/deps/
host-interfaces-2.1.0  host-outbox-1.0.0  host-tenant-1.0.0
```

**Impact.** A developer who follows the walkthrough literally goes looking for
`host-interfaces-2.2.0` and `host-tenant-1.2.0`, which are not in the published
repo. They either build against `2.2.0` (importing host functions the node does
not provide, which fails at runtime inside the TEE rather than at compile time)
or lose time hunting for packages that do not exist.

**Suggested fix.** Pin the versions in the walkthrough to the ones actually
vendored in the reference repo, and state the rule explicitly: *the WIT package
version must match the cluster's host ABI; the versions in the reference repo are
the ones the hosted clusters currently serve.*

---

## 3. `loadConfig()` silently ignores `T3N_ENV` and `T3N_NODE_URL`

**Severity: Medium** — silent wrong-environment selection.

The provisioning docs state:

> All commands that talk to the network accept `--env sandbox|testnet|production`
> (or the `T3N_ENV` environment variable)

But the SDK's own config loader does not read any environment variable:

```console
$ node -e '
  process.env.T3N_ENV = "production";
  process.env.T3N_NODE_URL = "https://example.invalid";
  process.env.T3N_ENVIRONMENT = "production";
  const sdk = require("@terminal3/t3n-sdk");
  console.log(JSON.stringify(sdk.loadConfig()));
  console.log(sdk.getNodeUrl());
'
{"environment":"testnet","nodeUrl":"https://cn-api.sg.testnet.t3n.terminal3.io","version":"5.17.0"}
https://cn-api.sg.testnet.t3n.terminal3.io
```

`T3N_ENV=production` produced a **testnet** config, with no warning and no error.
`loadConfig()` also never reads a key from the environment — setting
`T3N_API_KEY`, `T3N_AGENT_KEY`, and `T3N_PRIVATE_KEY` leaves the returned object
at `{environment, nodeUrl, version}`.

**Impact.** A CI job that sets `T3N_ENV=production` and relies on the SDK reading
it will silently target **testnet**. Because testnet is a live network, calls
"succeed" — they just write to the wrong cluster. This is the failure mode that
is hardest to notice: nothing errors, and the data is real, just on the wrong
chain. The docs' claim is true for the *CLI* (`--env` is honoured there) but the
sentence is written generally enough to cover the SDK.

**Suggested fix.** Either honour `T3N_ENV` / `T3N_NODE_URL` in `loadConfig()`, or
narrow the docs to say the flag/variable applies to the CLI only, and have
`loadConfig()` emit a warning when a `T3N_*` variable is present but unread.

---

## 4. The SDK is published obfuscated with no source maps

**Severity: Medium** — debuggability.

```console
$ head -c 60 index.js
/* t3n-sdk-obfuscated */
'use strict';const _0x503ddc=_0x393e;(function(...

$ ls *.map
ls: cannot access '*.map': No such file or directory
```

Every identifier is mangled (`_0x503ddc`, `_0x393e`) and no `.map` files ship.
A runtime failure therefore surfaces as a stack trace of minified frames. A
concrete example from this build: importing the SDK in an ESM context threw, and
the entire first 66 KB of output was obfuscated bundle text before the actual
error line appeared.

**Impact.** Any error inside the SDK is effectively undebuggable by the
developer. Note the *type* declarations are clean and well documented — so this
is purely a runtime-debugging cost, but a large one, and it makes the SDK
incompatible with the kind of "read the source to understand the protocol"
work the ADK otherwise encourages.

**Suggested fix.** Ship source maps (or a non-obfuscated `dist/`) and point
`package.json` `"sourceMap"`/`"sources"` at it. Obfuscation buys nothing here —
the SDK is a client for a public API, not a secret.

---

## 5. The configured browser backend cannot install: `data.camoufox.com` is NXDOMAIN

**Severity: Medium** — the documented claim path is unreachable with the shipped
tooling.

The shipped browser configuration selects Camoufox, and Camoufox cannot fetch its
own browser:

```console
$ camoufox fetch
ERR CamoufoxNotInstalled official/stable is not installed.
Please run 'camoufox fetch' to install.
```

The instruction it prints is the thing that just failed. Root cause — the
download backend does not resolve:

```console
$ dig +short data.camoufox.com
(no output — NXDOMAIN)
```

This is not a local misconfiguration: the binary is present, the profile
directory exists (`~/.camofox/profiles/<id>/`), and the fetch still fails. The
upstream project (`daijro/camoufox`) has no release assets to fall back to.

**Impact.** The error message is a loop — it tells the user to run the exact
command that failed, with no hint that the cause is an unresolvable upstream
host. Users on the documented path (claim a key, drive the ADK site) are stuck.

**Suggested fix.** Detect the download failure and say so ("cannot reach the
Camoufox download backend — check network/DNS"), rather than reporting the
browser as merely "not installed". Better: make the browser backend pluggable and
fall back to a bundled Chromium.

---

## 6. Quickstart snippet re-declares `trustAnchor` in a confusing way

**Severity: Low** — documentation clarity.

`quickstart.md` shows a client built with `trustAnchor: await fetchTrustedManifest("testnet")`
inline, and `invoke-contract.md` in the same walkthrough first assigns it to a
local `const trustAnchor`, then passes **both** the local and an inline fetch:

```ts
const trustAnchor = await fetchTrustedManifest("testnet"); // reused below
const agentClient = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"),   // ← fetched again
  ...
  trustAnchor,                                          // ← and again, from the local
});
```

The comments explain the intent ("one environment, one manifest"), but the code
as written fetches the manifest twice and passes the same property twice, which
reads as a mistake. Because `trustAnchor` is *required* and throwing on omission
is documented loudly, a reader cannot tell whether the duplication is load-bearing.

**Suggested fix.** Use the local variable in one place only:
`trustAnchor,` — and drop the inline fetch.

---

## 7. `cloud_provider: camofox` is the shipped default with no running server

**Severity: Low** — configuration default that cannot work out of the box.

`~/.hermes/config.yaml` ships `cloud_provider: camofox`, but no Camoufox server
is started by default, and (per finding 5) it could not be started even if it
were. Additionally the `CAMOFOX_URL` value present in the environment is
malformed — it contains an unescaped character, so it does not parse as a URL.

**Impact.** A fresh setup has a browser backend configured that cannot be reached,
and the failure surfaces late (at first page load) rather than at startup.

**Suggested fix.** Default to a backend that is present, or validate
`CAMOFOX_URL` (and the configured provider's reachability) at startup and fail
loudly with the reason.

---

## 8. The compiled capability set matches neither `world.wit` nor the docs' model

**Severity: Medium** — a security-relevant invariant that does not hold as stated.

The ADK is explicit that capabilities *are* the import list, with no separate
manifest:

> Import only the host interfaces you use — they are your contract's entire
> capability set. The host refuses to load a contract that imports an interface
> its tenant world does not provide.

That framing invites a reviewer to audit `wit/world.wit` and conclude they have
seen the full authority of the contract. They have not, in two distinct ways.

### (a) `wit-bindgen` silently prunes declared imports

Our `world.wit` declares four host interfaces; the built component imports four
`host:` interfaces — but not the same four:

```console
$ wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep 'import host:'
  import host:tenant/tenant-context@1.0.0;
  import host:interfaces/logging@2.1.0;
  import host:interfaces/kv-store@2.1.0;
  import host:interfaces/http-with-placeholders@2.1.0;
```

A declared `host:interfaces/http@2.1.0` is **absent**, because no code path
referenced it. So the *declared* list and the *effective* list differ, silently
and in the safe direction here — but the mechanism is symmetric: a reviewer
cannot tell from `world.wit` alone which of the declared imports actually made it
into the artifact, and nothing warns when a declared import is dropped.

**Why it matters.** "Audit the world file to know the capability set" is the
mental model the docs teach. The real answer requires running `wasm-tools` on the
binary. For a *grant* of authority the pruning direction is benign, but the same
silence would hide a typo'd interface name that the author believed was granting
(or withholding) a capability.

**Suggested fix.** Document that the compiled component — not the world file — is
the capability set, and have `wit-bindgen`/the ADK CLI warn on an unreferenced
declared import.

### (b) The Rust `std` prelude adds 14 `wasi:*` imports the developer never wrote

The same component imports:

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

`wasi:cli/stdin`, `environment`, `exit`, and `terminal-*` are all present in a
contract that reads no stdin, has no arguments, and returns via the exported
function. This is not specific to our crate: the reference contract
`z-tenant-flight`, with a byte-identical `[dependencies]` block, emits the same
14. The cause is that the ADK's documented `Cargo.toml` (and the reference repo's)
does not set `#![no_std]`, so `std`'s WASI glue is linked in wholesale.

**Why it matters.** For a platform whose entire pitch is *capability-minimised
execution inside a TEE*, "your contract's entire capability set is its import
list" is materially misleading when 14 interfaces are added by the toolchain
rather than by the author. A security reviewer comparing the world file against a
compliance checklist will under-count; one reading only the binary will find
authority the author never asked for and cannot explain. It also inflates the
artifact (217 KB, of which the WASI/std glue is a large fraction).

**Suggested fix.** Ship the walkthrough's `Cargo.toml` with a `no_std` variant
(or at least document that the import list will contain `wasi:*` regardless), and
note in the capability docs which imports are author-controlled versus
toolchain-injected.

**Workaround used in this repo.** None — we follow the documented `Cargo.toml`
exactly, so the artifact matches the reference contract. We document the gap in
the README and in `wit/world.wit` rather than pretending the four-import list is
the whole story.

---

## Note: two things that look like bugs but are not

Recorded so they are not re-reported:

- **`sandbox` and `testnet` resolve to the same node URL.** Intentional and
  documented: *"`sandbox` is an alias of `testnet`"*.
- **`maps.create()` without `readers` yields a deny-all map.** This is a
  documented footgun, not a defect — `MapCreateInput.readers` carries an explicit
  warning that omission defaults to deny-all, and the SDK emits a `console.warn`
  when it is omitted. It is called out in the docs' KV-map page too. Our contract
  sets `readers: { only: [contractId] }` explicitly.
