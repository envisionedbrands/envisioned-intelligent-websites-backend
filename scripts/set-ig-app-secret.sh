#!/usr/bin/env bash
# Takes the Instagram app secret from the clipboard and installs it in both
# places that need it, without the value ever passing through a terminal, a log,
# or a chat transcript.
#
# Copy it first from:
#   developers.facebook.com -> your app -> Use cases -> Instagram API
#   -> API setup with Instagram login -> Instagram app secret -> Show
#
# Then:  ./scripts/set-ig-app-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# A Meta app secret is 32 lowercase hex characters. Anything else means we were
# handed something other than what we asked for — refuse rather than write junk
# into .env.local and spend another hour on a 401.
looks_right() { printf '%s' "$1" | grep -Eq '^[a-f0-9]{32}$'; }

# Try the clipboard first, because when it works it costs nothing.
SECRET="$(pbpaste 2>/dev/null || true)"

# It usually will NOT work: copying the command needed to run this script
# overwrites the secret you copied a moment earlier. So fall back to asking
# directly. `read -rs` echoes nothing, and because the value arrives as input
# rather than as a command it never enters shell history either.
if ! looks_right "$SECRET" && [ -t 0 ]; then
  echo "Clipboard doesn't hold a Meta app secret — asking instead."
  echo "Go copy it now if you haven't; this will wait."
  echo
  printf 'Paste the Instagram app secret (nothing will appear as you paste): '
  IFS= read -rs SECRET
  echo
  # Paste picks up stray whitespace and newlines far more often than you'd think.
  SECRET="$(printf '%s' "$SECRET" | tr -d '[:space:]')"
fi

if ! looks_right "$SECRET"; then
  echo "That doesn't look like a Meta app secret (want 32 hex characters, got ${#SECRET})." >&2
  echo "Nothing was written. Re-run and try again." >&2
  exit 1
fi

if grep -q '^META_IG_APP_SECRET=' .env.local 2>/dev/null; then
  # Rewrite in place via a temp file; -i '' would still expose it in ps output.
  grep -v '^META_IG_APP_SECRET=' .env.local > .env.local.tmp
  mv .env.local.tmp .env.local
fi
printf 'META_IG_APP_SECRET=%s\n' "$SECRET" >> .env.local
echo "Wrote META_IG_APP_SECRET to .env.local"

printf '%s' "$SECRET" | npx wrangler secret put META_IG_APP_SECRET
echo "Set META_IG_APP_SECRET as a Worker secret"

unset SECRET
