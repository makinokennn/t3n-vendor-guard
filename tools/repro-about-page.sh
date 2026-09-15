#!/usr/bin/env bash
# BUGS.md finding 5: intro/about-t3.md sends two of its four product cards to a
# /documentation/products/* section that does not exist, and has a typo.
#
# Everything below is fetched live; nothing is transcribed by hand.
set -uo pipefail

DOCS=https://docs.terminal3.io

echo '$ curl -sSL -o about-t3.md https://docs.terminal3.io/intro/about-t3.md'
curl -sSL --max-time 45 -o /tmp/vg-about.md "$DOCS/intro/about-t3.md"
echo "  fetched $(wc -c < /tmp/vg-about.md) bytes"
echo

echo '# the two cards that dead-end'
echo '$ grep -oE "href=\"/documentation/products/[a-z]+\"" about-t3.md'
grep -oE 'href="/documentation/products/[a-z]+"' /tmp/vg-about.md
echo

echo '# both 404 (with -L, so a redirect that resolves cannot mask a live page)'
for slug in identity verify; do
  printf '$ curl -o /dev/null -w "%%{http_code}\\n" -L %s/documentation/products/%s\n' "$DOCS" "$slug"
  curl -sS -o /dev/null -w '%{http_code}\n' -L --max-time 30 "$DOCS/documentation/products/$slug"
done
echo

echo '# and the section is missing from the docs index entirely, not just these slugs'
echo '$ curl -sSL https://docs.terminal3.io/llms.txt | grep -oE "docs\.terminal3\.io/[a-z0-9/-]+\.md" | cut -d/ -f2 | sort | uniq -c | sort -rn'
curl -sSL --max-time 45 "$DOCS/llms.txt" \
  | grep -oE 'docs\.terminal3\.io/[a-z0-9/-]+\.md' \
  | cut -d/ -f2 | sort | uniq -c | sort -rn
echo '$ curl -sSL https://docs.terminal3.io/llms.txt | grep -c "products/"'
curl -sSL --max-time 45 "$DOCS/llms.txt" | grep -c 'products/' || true
echo

echo '# the typo on the same page'
echo '$ grep -n "withoutc" about-t3.md'
grep -n 'withoutc' /tmp/vg-about.md
