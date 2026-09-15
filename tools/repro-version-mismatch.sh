#!/usr/bin/env bash
# BUGS.md finding 3: write-contract.md tells you to vendor host-interfaces-2.2.0 /
# host-tenant-1.2.0 and shows those versions in world.wit. Following it literally
# fails to build.
#
# Self-contained: copies the contract to a temp dir, patches the world to the
# walkthrough's versions, and builds. Nothing in the repo is modified.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -r "$REPO/contract" "$WORK/contract"
rm -rf "$WORK/contract/target"
cd "$WORK/contract"

echo '$ sed -n "42p;52,56p" write-contract.md     # what the docs tell you to vendor'
echo 'The packages under `wit/deps/` define the host ABI your contract links against —'
echo 'vendor the versions your target cluster provides (here, `host-interfaces-2.2.0/`'
echo 'and `host-tenant-1.2.0/`).'
echo '  import host:tenant/tenant-context@1.2.0;'
echo '  import host:interfaces/logging@2.2.0;'
echo '  import host:interfaces/kv-store@2.2.0;'
echo '  import host:interfaces/http@2.2.0;'
echo '  import host:interfaces/http-with-placeholders@2.2.0;'
echo
echo '$ # apply exactly those versions to world.wit, then build:'
python3 - <<'PY'
import pathlib
p = pathlib.Path("wit/world.wit")
s = p.read_text().replace("@1.0.0", "@1.2.0").replace("@2.1.0", "@2.2.0")
p.write_text(s)
for line in s.splitlines():
    if "import host:" in line:
        print("   ", line.strip())
PY
echo
echo '$ cargo build --release --target wasm32-wasip2'
cargo build --release --target wasm32-wasip2 --quiet 2>&1 | head -14 || true
echo
echo '# the toolchain lists the versions that actually exist (2.1.0 / 1.0.0).'
echo '# The docs page dedicated to capabilities uses those same versions --'
echo '# i.e. the docs contradict each other:'
echo '#   tips/capabilities-from-wit-import.md:'
echo '  import host:tenant/tenant-context@1.0.0;'
echo '  import host:interfaces/logging@2.1.0;'
echo '  import host:interfaces/kv-store@2.1.0;'
echo '  import host:interfaces/http@2.1.0;'
echo '#   ...and the reference repo pins the same, deliberately:' 
echo '  // Held at @2.1.0 deliberately so existing contracts (user / vc /'
echo '  // agent-registry / organisation / payroll), all pinned to @2.1.0'
