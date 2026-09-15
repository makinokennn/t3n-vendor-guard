# Bug Report: Terminal 3 (T3N) ADK

Findings collected while building `vendor-guard` against `@terminal3/t3n-sdk@5.17.0`,
the published docs (`docs.terminal3.io`), and the reference repo `z-tenant-flight`.

**Every entry was reproduced from a primary source, and every claim was re-checked
with the intent of disproving it.** Commands and raw output are included so each
finding can be re-run. Where a finding turned out to be documented, warned about,
or our own error, it was withdrawn. Three of them are at the bottom.

Verified against the live docs on 2026-09-15: the three pages cited below are
byte-identical to what `https://docs.terminal3.io/<path>.md` served, so nothing
here is a stale-cache artefact.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | The docs' own `invoke-contract.md` snippet does not compile (`TS1117`, duplicate key), plus a second duplicate in its import list | **High** | Confirmed |
| 2 | A declared host import is silently pruned from the compiled artifact. The capability set the docs call authoritative is not what you declared (pruned direction only: never *more* than declared) | Medium | Confirmed |
| 3 | `write-contract.md`'s host-interface versions (`2.2.0`/`1.2.0`) break the build; the page contradicts both the reference repo and the docs' own capability page (`2.1.0`/`1.0.0`) | **Medium** | Confirmed |
| 4 | The SDK ships obfuscated with no source maps, so static review of it returns false negatives | **Medium** | Confirmed |
| — | `contract_id` is `number` on register / `string` on invoke | — | **Withdrawn**: documented |
| — | `T3N_ENV` is ignored by the SDK | — | **Withdrawn**: the CLI honours it; our probe was wrong |
| — | Camoufox browser backend cannot install | — | **Withdrawn**: not a T3N component |

Severity rubric, calibrated to the ADK's own surface and applied consistently:

- **High**: following the docs literally fails, **and the docs offer no correct
  alternative on that path**. The reader has to work out the fix themselves.
- **Medium**: following the docs fails or misleads, **but the correct behaviour is
  stated elsewhere in the docs, or named by the toolchain's own error message**, so
  the reader recovers quickly.

Under this rubric finding 1 is High (the walkthrough's snippet is uncopyable and
nothing in the docs shows a working version), while findings 2–4 are Medium: each
is a real divergence, but each is either self-announcing or contradicted by
another page the same docs point you to.

## Why these four and not the rest

Two independent tests were applied to every candidate, and a finding is only
listed if it passes both:

1. **Reproducible from a primary source.** Re-running the quoted command on a
   clean copy produces the quoted output. No claim rests on inference from a
   single grep, on a screenshot we cannot regenerate, or on our own memory.
2. **Not the documented behaviour.** If a page states the behaviour, warns about
   it, or the SDK emits a `console.warn`, it is not a defect and is not counted,
   regardless of how surprising it is.

Both tests were run adversarially: for each finding we first tried to find the
reason it was *not* a bug. Finding 3 was nearly withdrawn on the strength of the
changelog (see below); it survived only because the live page still fails.

---

## 1. The docs' own walkthrough snippet does not compile

**Severity: High.** The last step of the walkthrough is uncopyable.

`walkthrough/invoke-contract.md` builds the agent's client with an object literal
that passes `trustAnchor` twice. The snippet is reproduced verbatim from the live
page (line numbers are within the snippet):

```console
$ sed -n '33,40p' invoke-contract.md        # live page, fetched 2026-09-15
const agentClient = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"),
  wasmComponent,   // node URL resolved from setEnvironment(); see set-up-dev-env
  trustAnchor,
  handlers: {
    EthSign: metamask_sign(agentAddress, undefined, agentKey),
  },
});
```

TypeScript rejects it:

```console
$ ./node_modules/.bin/tsc --ignoreConfig --noEmit --target es2022 --module esnext repro.ts
repro.ts(4,3):  error TS2300: Duplicate identifier 'fetchTrustedManifest'.
repro.ts(10,3): error TS2300: Duplicate identifier 'fetchTrustedManifest'.
repro.ts(21,3): error TS1117: An object literal cannot have multiple properties with the same name.
exit 1
```

`TS1117` is the object-literal duplicate; the two `TS2300`s are a *second*
duplicate on the same page: `fetchTrustedManifest` is imported twice in the
import list at the top of the file (lines 19 and 25). So the snippet has two
independent copy-paste defects.

**Negative control.** Removing only the duplicated `trustAnchor,` line makes
`TS1117` disappear, leaving every other error untouched, proving that line, and
not some environmental difference, is the cause:

```console
$ sed '21d' repro.ts > repro-fixed.ts
$ tsc --ignoreConfig --noEmit --target es2022 --module esnext repro-fixed.ts | grep -c TS1117
0
```

**Why it is not by design.** A snippet in a walkthrough is meant to be pasted and
run. There is no reading under which an object literal with a repeated key is
intentional, and the page's own surrounding prose says the value is "reused below
for every client in this file". The author's intent was clearly the single
`trustAnchor` binding declared on the line above, not a second inline fetch.

**Why it still matters after a partial fix.** The changelog's 2026-09-08 entry
records fixing "a duplicated code sample in Quickstart". The Quickstart page is
indeed fixed on the live site (`grep` shows one `trustAnchor` key there). This
page was not, so the same class of defect remains in the very next page of the
same walkthrough.

**Suggested fix.** Delete the `trustAnchor,` line (or the inline
`trustAnchor: await fetchTrustedManifest("testnet")` line) and de-duplicate the
import list.

---

## 2. A declared host import is silently pruned from the compiled artifact

**Severity: Medium.** The capability set is not introspectable from the world
file, and a dropped import is never announced. *(Not High: the divergence is
always in the safe direction (never more capability than declared), and a
mistyped name fails the build loudly. See the impact bounds below.)*

The docs are unambiguous that the declared imports *are* the capability set:

> "The interfaces you import here are your contract's entire capability set —
> there is no separate manifest." (from `walkthrough/write-contract.md`)

> "Capabilities are determined by the host interfaces imported in your
> contract's `world.wit`" (from `tips/capabilities-from-wit-import.md`)

That is not what happens. `wit-bindgen` drops any declared import that no code
path references, and the build says nothing about it.

**Controlled experiment.** Starting from the reference layout, declare four
imports and build, and four are compiled in:

```console
$ grep -c "import host:" wit/world.wit
4
$ cargo build --release --target wasm32-wasip2
    Finished `release` profile [optimized] target(s) in 30.36s
$ wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep -c "import host:"
4
```

Now add `host:interfaces/http@2.1.0`, which no code path calls, and rebuild:

```console
$ grep -c "import host:" wit/world.wit
5
$ grep -rn "interfaces::http\b" src/            # nothing references it
$ cargo build --release --target wasm32-wasip2
    Finished `release` profile [optimized] target(s) in 3.00s
$ wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep "import host:"
  import host:tenant/tenant-context@1.0.0;
  import host:interfaces/logging@2.1.0;
  import host:interfaces/kv-store@2.1.0;
  import host:interfaces/http-with-placeholders@2.1.0;
```

Declared five, compiled four, no warning, no error, no build-log note. The
`http` import is simply gone. In this direction the artifact has *less* authority
than declared, but the mechanism is silent and symmetric, and the other
direction is the dangerous one.

**Why it is not by design.** "Your contract's entire capability set" is a claim
about what the contract *can do*. If the artifact can differ from the declaration
with no diagnostic, then the declaration is not a reliable description of the
capability set, which is precisely the property the sentence promises. A
documented limitation would say "unused imports are dropped"; no page does.

**Impact, and an honest bound on it.** We tried to establish the worst case and
could not. Two candidate failure modes were tested:

- **A typo'd interface name** (`host:interfaces/kvstore@2.1.0` for `kv-store`):
  this does **not** fail silently. It fails the build with
  `interface not found in package`, pointing at the line. So the "silent loss"
  scenario does not occur. *(An earlier draft of this report claimed it did; that
  claim was wrong and is retracted here.)*
- **An unused but correctly-named import:** pruned from the artifact with no
  warning of any kind (verified against full build output: zero `warning` lines,
  and the artifact still lists four).

What remains is therefore narrower than "silent capability loss": the *practical*
impact today is low, because the pruned direction is the safe one (fewer
capabilities than declared, never more). The real cost is **auditability and
diagnosis**:

- A reviewer auditing `world.wit` sees five imports and has no way to know the
  artifact carries four, so the docs' sentence "your contract's entire capability
  set" points them at the wrong artefact.
- When an interface *is* dropped, nothing tells the developer. The build log is
  clean. They find out by inspecting the component, if at all.
- The docs' enforcement statement, *"The host refuses to load a contract that
  imports an interface its tenant world does not provide"*, covers only the
  extra-import case. Nothing states the declared-but-dropped case, which is the
  one that occurs.

We are rating this **Medium**, not High: it misleads review and diagnosis rather
than breaking a documented path or weakening the trust boundary. Anyone building
on this should treat the compiled component, not `world.wit`, as authoritative.

**Suggested fix.** Have the ADK CLI or `wit-bindgen` warn on an unreferenced
declared import, and state in the capability docs that the *compiled component*
(not the world file) is the authoritative capability set.

*(A separate, weaker observation about the same page: the Rust `std` prelude also
links in 14 `wasi:*` imports the author never wrote. That one is **not** counted
as a finding. The reference contract, with a byte-identical `[dependencies]`
block, emits the same 14, so it is the toolchain baseline, not a platform defect.
It is noted only because it reinforces the point above: the import list in
`world.wit` is not the capability set.)*

---

## 3. Documented host-interface versions break the build, and contradict the docs' own capability page

**Severity: Medium.** A fresh project that follows this page does not build.

`walkthrough/write-contract.md` tells you which versions to vendor and shows them
in the example world:

```console
$ sed -n '42p;52,56p' write-contract.md          # live page, fetched 2026-09-15
The packages under `wit/deps/` define the host ABI your contract links against —
vendor the versions your target cluster provides (here, `host-interfaces-2.2.0/`
and `host-tenant-1.2.0/`).
  import host:tenant/tenant-context@1.2.0;
  import host:interfaces/logging@2.2.0;
  import host:interfaces/kv-store@2.2.0;
  import host:interfaces/http@2.2.0;                    // search (no PII)
  import host:interfaces/http-with-placeholders@2.2.0;  // booking (PII via placeholders)
```

Following that literally fails. Editing the world to those versions and building:

```console
$ cargo build --release --target wasm32-wasip2
error: failed to resolve directory while parsing WIT for path [wit]
       Caused by:
         package 'host:tenant@1.2.0' not found. known packages:
           host:interfaces@2.1.0
           host:tenant@1.0.0
           z:vendor-guard@0.1.0
            --> wit/world.wit:24:12
             |
          24 |     import host:tenant/tenant-context@1.2.0;
             |            ^----------
```

The toolchain's own error lists the packages that *do* exist: `2.1.0` and
`1.0.0`. So the page's version numbers are not stale relative to the
reference repo, they are unbuildable in a project set up exactly as the
walkthrough instructs.

**The docs contradict each other.** The page dedicated to this exact topic uses
the versions that work:

```console
$ sed -n '13,19p' tips/capabilities-from-wit-import.md
world your-contract {
  import host:tenant/tenant-context@1.0.0;
  import host:interfaces/logging@2.1.0;
  import host:interfaces/kv-store@2.1.0;
  import host:interfaces/http@2.1.0;   // ← opting into outbound HTTP
}
```

Those match the reference repo the same walkthrough tells you to clone, whose
vendored package explains the pin in its own header:

```console
$ head -5 wit/deps/host-interfaces-2.1.0/package.wit
// Held at @2.1.0 deliberately so existing contracts (user / vc /
// agent-registry / organisation / payroll), all pinned to @2.1.0
// in their per-contract wit/deps copies, continue to link against
// the host runtime. The new T3-TS-029 §6.3 / §7.1–§7.3 interfaces
// (`profile-ref`, `vp.verify`, `clock`,
```

So: two docs pages give two different version sets for the same interfaces, and
the one in the step-by-step walkthrough is the wrong one. The correct answer is
discoverable only by reading a comment inside a vendored file.

**Why it is not by design.** `2.1.0` is deliberate (the package says so); `2.2.0`
is an inconsistency. A reader following the walkthrough hits a build failure
whose message points at their own `world.wit`, not at the docs that told them to
write it.

**Checklist for the fix. The changelog says this was already done, but it was not.**
The 2026-09-08 changelog entry states it fixed "outdated host-interface version
numbers in Write your first TEE contract". The live page still carries `2.2.0` and
`1.2.0` (fetched and byte-compared on 2026-09-15), so either the fix did not land
or it was reverted. Grepping the live page for version strings returns exactly:
`host-interfaces-2.2.0`, `host-tenant-1.2.0`, `@1.2.0`, and four `@2.2.0`, the
same values as before the claimed fix.

**Suggested fix.** Change `write-contract.md` lines 42 and 52–56 to
`host-interfaces-2.1.0` / `host-tenant-1.0.0` and the matching `@2.1.0` /
`@1.0.0` import versions, to agree with `capabilities-from-wit-import.md` and the
reference repo.

---

## 4. The SDK is published obfuscated, with no source maps

**Severity: Medium.** Debuggability, and the soundness of static review.

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

Every identifier is mangled (`_0x503ddc`, `_0x393e`) and no `.map` files ship, so
every SDK frame in a stack trace points into a single very long line at an
enormous column offset. Reproduced:

```console
$ node --input-type=module -e 'const {T3nClient}=await import("@terminal3/t3n-sdk"); new T3nClient({})'
T3nConfigError: T3nClient: `trustAnchor` is required and must be either a
TrustAnchor ({ expected_peer_ids, rtmr3_allowlist, rtmr1_allowlist }) ...
    at new T3nClient (file:///.../t3n-sdk/dist/index.esm.js:2:456604)
    at file:///.../[eval1]:1:59
```

`index.esm.js:2:456604` is line 2, column 456604. It tells a developer nothing
about which part of the SDK failed.

**Why it is not by design, and why it is worth reporting beyond readability.** The
obfuscator also encodes string literals into a lookup table, so *static inspection
returns false negatives*. This bit us directly: our own earlier draft reported
"`T3N_ENV` is documented but ignored by the SDK" on the strength of

```console
$ grep -c "T3N_ENV" node_modules/@terminal3/t3n-sdk/dist/cli/index.js
0
```

Yet the CLI demonstrably honours it:

```console
$ t3n did get did:t3n:0123…4567 --env testnet        # succeeds
$ T3N_ENV=production t3n did get did:t3n:0123…4567   # error: fetch failed
                                                     # (switched off testnet)
```

The string is absent from the file's text but present in behaviour. A negative
conclusion drawn from reading this bundle is unsound, which is exactly the kind
of conclusion a security reviewer is asked to draw. (That earlier draft finding is
withdrawn; see W1. It is recorded here because it is evidence *for* this finding.)

To be fair to the platform: the error *messages* are unusually good and the error
classes are named. The problem is the frame and the unsoundness of static reading,
not the diagnostics' wording.

**Suggested fix.** Ship source maps (or an unobfuscated `dist/`) and point
`package.json` at them. Obfuscation buys little for a public-API client whose
protocol surface is already documented.

---

## Withdrawn findings

Kept because a bug report is only useful if it says what it got wrong. Each of
these was in an earlier draft and was removed after re-checking against a primary
source.

### W1. `T3N_ENV` is documented but ignored by the SDK (*withdrawn*)

**Claim (wrong).** The docs say env vars are honoured; `grep -c T3N_ENV` on the
published bundle returns 0, so the SDK must ignore it and silently fall back to
testnet.

**What disproved it.** A behavioural test, not a text search. The SDK's own CLI
reads `T3N_ENV` and switches cluster:

```console
$ t3n did get did:t3n:0123…4567 --env testnet      → resolves on testnet
$ T3N_ENV=production t3n did get did:t3n:0123…4567 → error: fetch failed
```

The environment variable is honoured. Our grep was a false negative caused by the
obfuscation described in finding 4: the string is not stored as plain text. **The
probe was wrong, not the platform.** This withdrawal is itself the strongest
evidence for finding 4.

### W2. `contract_id` is `number` on register and `string` on invoke (*withdrawn*)

**Claim (wrong).** The SDK types disagree, so one of them must be a bug.

**What disproved it.** `register-contract.md` documents the situation explicitly:

> "there is currently no API to fetch a tail's current `contract_id` after
> re-registering, so if you created map ACLs scoped to the old `contract_id`, a
> re-registration can leave them pointing at a stale id. Keep a record of each
> `contract_id` your tenant registers so you can re-grant map access if needed."

That is a documented limitation, not a defect. Independently: `contract_id: number`
occurs once in `index.d.ts` (the ACL/register surface, where it is a numeric map
id) against seven `contract_id: string` declarations, and `invoke-contract.md`
shows `contract_id` as the `z:<tid>:<name>` *path*, not a number. Reading the two
as one inconsistent type was our error.

### W3. The Camoufox browser backend cannot install (*withdrawn*)

**Claim (wrong).** A dependency could not be installed, so the ADK's tooling is
broken.

**What disproved it.** Camoufox appears nowhere in the T3N documentation, and is
not part of the ADK. It was a component of our own local test harness, and its
download host was NXDOMAIN. Reporting a local-environment failure against the
platform was a category error. Removed entirely.

---

## Note: two more things that look like bugs but are not

- **`sandbox` and `testnet` resolve to the same node URL.** Intentional and
  documented: *"`sandbox` and `testnet` are the same test network."*
- **`maps.create()` without `readers` yields a deny-all map.** A documented
  footgun, not a defect: `MapCreateInput.readers` carries an explicit warning
  that omission defaults to deny-all, the SDK emits a `console.warn` when it is
  omitted, and the KV-map docs call it out. Our contract sets
  `readers: { only: [contractId] }` explicitly.
