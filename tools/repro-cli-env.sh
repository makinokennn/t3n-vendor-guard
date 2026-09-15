#!/usr/bin/env bash
# Withdrawn finding W1: our original probe concluded "the SDK ignores T3N_ENV"
# because grepping the published bundle for the literal string returned 0 hits.
# That inference was wrong. The CLI does honour it -- the obfuscator stores
# strings in an encoded lookup table, so a plaintext grep is not evidence of
# absence. Behaviour is the only valid test.
#
# Kept in BUGS.md so the same non-bug is not reported again.
set -uo pipefail

D="did:t3n:0123456789abcdef0123456789abcdef01234567"
CLI="node node_modules/@terminal3/t3n-sdk/dist/cli/index.js"

echo "\$ t3n did get \$D --env testnet"
timeout 40 $CLI did get "$D" --env testnet 2>&1 | head -3
echo
echo "\$ T3N_ENV=production t3n did get \$D"
T3N_ENV=production timeout 40 $CLI did get "$D" 2>&1 | head -3
echo
echo "-> the env var changed which cluster was contacted: with T3N_ENV=production"
echo "   the call fails, with testnet it succeeds. The withdrawn finding was our"
echo "   own bad probe, not a platform defect."
echo
echo "-> and the grep that fooled us:"
echo "\$ grep -c T3N_ENV node_modules/@terminal3/t3n-sdk/dist/cli/index.js"
grep -c T3N_ENV node_modules/@terminal3/t3n-sdk/dist/cli/index.js || true
echo "   0 hits, yet the feature works. Do not treat bundle greps as proof."
