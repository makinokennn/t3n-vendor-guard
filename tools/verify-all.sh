#!/usr/bin/env bash
# Verify every claim this repo makes, in one command.
#
#   ./tools/verify-all.sh
#
# Runs the Rust tests, the TypeScript tests, the typecheck, rebuilds the
# component and checks its hash, and re-runs the two doc-bug reproductions that
# need no toolchain beyond curl. Prints PASS/FAIL per step and exits non-zero if
# anything fails, so it is usable in CI.
#
# Nothing here needs a Terminal 3 tenant or an API key. The parts that do are
# listed at the end as SKIP rather than quietly omitted.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

pass=0; fail=0; skip=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
sk()   { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; skip=$((skip+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

EXPECTED_WASM_SHA="e1876458b2c0072bb192971e265f070b5c94f5c2226cf6e28d34179ba4be7f8a"

head_ "1. Rust contract: 36 tests (35 unit + 1 doc-test) on the host target"
if command -v cargo >/dev/null 2>&1; then
  out=$(cargo test --manifest-path contract/Cargo.toml \
        --target x86_64-unknown-linux-gnu 2>&1)
  n=$(printf '%s' "$out" | grep -oE '[0-9]+ passed' | awk '{s+=$1} END {print s+0}')
  if printf '%s' "$out" | grep -q "test result: FAILED"; then
    no "cargo test reported failures"
  elif [ "$n" -ge 36 ]; then
    ok "$n tests passed"
  else
    no "expected >=36 passing tests, counted $n"
  fi
else
  sk "cargo not installed"
fi

head_ "2. Contract builds to a real wasm32-wasip2 component"
if command -v cargo >/dev/null 2>&1; then
  if cargo build --manifest-path contract/Cargo.toml \
       --release --target wasm32-wasip2 >/dev/null 2>&1; then
    ok "cargo build --target wasm32-wasip2 succeeded"
  else
    no "wasm build failed"
  fi
else
  sk "cargo not installed"
fi

head_ "3. The committed artifact matches its recorded hash"
WASM="contract/target/wasm32-wasip2/release/vendor_guard.wasm"
if [ -f "$WASM" ]; then
  got=$(sha256sum "$WASM" | cut -d' ' -f1)
  if [ "$got" = "$EXPECTED_WASM_SHA" ]; then
    ok "sha256 $got"
  else
    no "sha256 mismatch: got $got"
  fi
else
  sk "artifact not built (run step 2)"
fi

head_ "4. Capability set actually in the artifact"
if command -v wasm-tools >/dev/null 2>&1 && [ -f "$WASM" ]; then
  wit=$(wasm-tools component wit "$WASM" 2>/dev/null)
  host=$(printf '%s' "$wit" | grep -c "import host:")
  wasi=$(printf '%s' "$wit" | grep -c "import wasi:")
  ok "$host host: interfaces, $wasi wasi: interfaces (BUGS.md #2 documents this gap)"
else
  sk "wasm-tools not installed, or artifact missing"
fi

head_ "5. TypeScript agent: typecheck and 42 tests"
if command -v npx >/dev/null 2>&1 && [ -d agent/node_modules ]; then
  if (cd agent && npx tsc --noEmit >/dev/null 2>&1); then
    ok "tsc --noEmit clean"
  else
    no "tsc --noEmit reported errors"
  fi
  # node's TAP summary uses "# pass N"; the newer reporter uses "ℹ pass N".
  t=$(cd agent && node --test "test/**/*.test.ts" 2>&1 \
      | grep -oE '(#|ℹ) ?pass [0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ "${t:-0}" -ge 42 ]; then ok "$t tests passed"; else no "expected >=42 tests, got ${t:-0}"; fi
else
  sk "node/npx or agent/node_modules missing (run: cd agent && npm ci)"
fi

head_ "6. BUGS.md reproductions that need only curl"
if command -v curl >/dev/null 2>&1; then
  c1=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 30 \
       "https://docs.terminal3.io/documentation/products/identity")
  [ "$c1" = "404" ] && ok "finding 5: /documentation/products/identity is 404" \
                    || no "finding 5: expected 404, got $c1"
  if curl -sS --max-time 30 "https://docs.terminal3.io/intro/about-t3.md" \
       | grep -q "withoutc"; then
    ok "finding 5: the 'withoutc' typo is still live"
  else
    no "finding 5: typo is gone (fixed upstream?)"
  fi
else
  sk "curl not installed"
fi

head_ "Not verified here"
sk "finding 1 (docs snippet TS1117) - needs the docs' own snippet extracted, see BUGS.md"
sk "finding 3 (version mismatch build) - tools/repro-version-mismatch.sh, needs cargo"
sk "finding 4 (no source maps) - tools/repro-* , needs the SDK installed"
sk "end-to-end register/invoke on testnet - needs a claimed tenant, see docs/SETUP.md"

printf '\n\033[1mSummary:\033[0m %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1
