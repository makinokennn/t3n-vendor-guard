#!/usr/bin/env bash
# BUGS.md finding 2(a): a host import that is declared in world.wit but never
# called is silently pruned from the compiled component.
#
# Self-contained: works from a throwaway copy, so it does not depend on any
# leftover build state. Requires cargo + the wasm32-wasip2 target + wasm-tools.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -r "$REPO/contract" "$WORK/contract"
cd "$WORK/contract"
rm -rf target

# Declare one more host import than the code actually uses. Nothing calls
# host:interfaces/http — it is here purely to see whether it survives the build.
sed -i 's#^\([[:space:]]*import host:interfaces/kv-store@2\.1\.0;\)#\1\n    import host:interfaces/http@2.1.0;#' wit/world.wit

echo "\$ grep -c 'import host:' wit/world.wit   # declared"
grep -c 'import host:' wit/world.wit
echo
echo "\$ cargo build --release --target wasm32-wasip2"
cargo build --release --target wasm32-wasip2 2>&1 | tail -2
echo
echo "\$ wasm-tools component wit target/wasm32-wasip2/release/*.wasm | grep 'import host:'"
wasm-tools component wit target/wasm32-wasip2/release/*.wasm | grep 'import host:'
echo
echo "-> declared 5, compiled 4. host:interfaces/http is gone, with no warning"
echo "   and no error: wit-bindgen drops imports no code path references."
