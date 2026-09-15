#!/usr/bin/env bash
# Publish this repo to GitHub. Needs either an authenticated `gh`, or a token.
#
#   ./tools/push.sh                      # uses gh auth (gh auth login first)
#   GH_TOKEN=ghp_... ./tools/push.sh     # or an explicit token
#
# The token is read from the environment and never written to the repo or to
# shell history.
set -euo pipefail

REPO_NAME="${REPO_NAME:-t3n-vendor-guard}"
VISIBILITY="${VISIBILITY:-public}"
DESC="Policy-gated vendor payouts on Terminal 3 — the money-moving logic lives in the TEE, not in the model"

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repo" >&2; exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "warning: working tree is dirty; commit first if you want it included" >&2
fi

if [ -n "${GH_TOKEN:-}" ]; then
  # Create the repo (idempotent) and push over HTTPS with the token.
  owner=$(curl -sS -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user \
          | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$owner" ] || { echo "could not resolve the token's user" >&2; exit 1; }
  echo "authenticated as: $owner"

  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GH_TOKEN" \
         "https://api.github.com/repos/$owner/$REPO_NAME")
  if [ "$code" = "404" ]; then
    curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      https://api.github.com/user/repos \
      -d "{\"name\":\"$REPO_NAME\",\"description\":\"$DESC\",\"private\":$([ "$VISIBILITY" = public ] && echo false || echo true)}" \
      >/dev/null
    echo "created $owner/$REPO_NAME ($VISIBILITY)"
  else
    echo "repo $owner/$REPO_NAME already exists"
  fi

  git remote remove origin 2>/dev/null || true
  git remote add origin "https://$owner:$GH_TOKEN@github.com/$owner/$REPO_NAME.git"
  git push -u origin HEAD:main
  # do not leave the token in .git/config
  git remote set-url origin "https://github.com/$owner/$REPO_NAME.git"
  echo
  echo "done: https://github.com/$owner/$REPO_NAME"
  echo "NOTE: run the push again yourself later; the credential is not stored."
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "no gh and no GH_TOKEN — install gh or export GH_TOKEN" >&2; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2; exit 1
fi

gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --description "$DESC" --push 2>/dev/null \
  || { git remote add origin "$(gh repo view --json sshUrl -q .sshUrl 2>/dev/null)" 2>/dev/null || true; git push -u origin HEAD:main; }

echo
gh repo view --json url -q .url
