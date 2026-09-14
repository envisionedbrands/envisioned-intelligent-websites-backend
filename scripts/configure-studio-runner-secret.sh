#!/bin/bash
# Masked, local-only credential entry for optional Studio runner lanes.
# The setup agent owns consent; this helper only stores an already-approved
# secret without moving its value through chat, argv, stdout or shell history.
set -euo pipefail
set +x
umask 077

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
SECRET_NAME="${1:-}"

case "$SECRET_NAME" in
  ANTHROPIC_API_KEY|FAL_KEY|OPENAI_API_KEY) ;;
  *)
    echo "Usage: bash scripts/configure-studio-runner-secret.sh ANTHROPIC_API_KEY|FAL_KEY|OPENAI_API_KEY" >&2
    exit 2
    ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — install/configure the Digital Home environment first." >&2
  exit 1
fi
if [ -L "$ENV_FILE" ]; then
  echo "$ENV_FILE must be a regular local file, not a symbolic link." >&2
  exit 1
fi

# Fail before asking for a secret unless both the permanent environment and a
# possible SIGKILL-left temporary file are outside Git's tracking surface.
# Owner-only permissions protect the local machine; ignore + untracked checks
# protect against a later broad `git add` publishing the credential.
GIT_BIN="$(command -v git || true)"
if [ -z "$GIT_BIN" ] || ! "$GIT_BIN" -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "The Digital Home must be a Git worktree before an optional runner secret can be stored." >&2
  exit 1
fi
if "$GIT_BIN" -C "$REPO_DIR" ls-files --error-unmatch -- .env.local >/dev/null 2>&1; then
  echo "Refusing to store a secret: .env.local is tracked by Git. Remove it from the index and ignore it first." >&2
  exit 1
fi
if ! "$GIT_BIN" -C "$REPO_DIR" check-ignore -q --no-index -- .env.local; then
  echo "Refusing to store a secret: .env.local is not ignored by Git." >&2
  exit 1
fi
if ! "$GIT_BIN" -C "$REPO_DIR" check-ignore -q --no-index -- .env.local.studio-secret.probe; then
  echo "Refusing to store a secret: .env.local.studio-secret.* is not ignored by Git." >&2
  exit 1
fi
if ! { : < /dev/tty; } 2>/dev/null; then
  echo "A local interactive terminal is required. The secret must not be piped or passed on the command line." >&2
  exit 1
fi

printf 'Paste %s (input hidden): ' "$SECRET_NAME" > /dev/tty
IFS= read -r -s SECRET_VALUE < /dev/tty
printf '\n' > /dev/tty
if [ -z "$SECRET_VALUE" ] || [[ "$SECRET_VALUE" =~ [[:space:]] ]]; then
  unset SECRET_VALUE
  echo "No valid secret was stored." >&2
  exit 1
fi

ENV_TMP="$(/usr/bin/mktemp "$REPO_DIR/.env.local.studio-secret.XXXXXX")"
cleanup() {
  if [ -n "${ENV_TMP:-}" ] && [ -f "$ENV_TMP" ]; then
    /bin/rm -f -- "$ENV_TMP"
  fi
}
trap cleanup EXIT HUP INT TERM

REPLACED=0
while IFS= read -r ENV_LINE || [ -n "$ENV_LINE" ]; do
  if [[ "$ENV_LINE" == "$SECRET_NAME="* ]]; then
    if [ "$REPLACED" -eq 0 ]; then
      printf '%s=%s\n' "$SECRET_NAME" "$SECRET_VALUE" >> "$ENV_TMP"
      REPLACED=1
    fi
  else
    printf '%s\n' "$ENV_LINE" >> "$ENV_TMP"
  fi
done < "$ENV_FILE"
if [ "$REPLACED" -eq 0 ]; then
  printf '%s=%s\n' "$SECRET_NAME" "$SECRET_VALUE" >> "$ENV_TMP"
fi
unset SECRET_VALUE ENV_LINE

/bin/chmod 600 "$ENV_TMP"
/bin/mv -f -- "$ENV_TMP" "$ENV_FILE"
ENV_TMP=""
/bin/chmod 600 "$ENV_FILE"
trap - EXIT HUP INT TERM

echo "$SECRET_NAME stored locally with owner-only permissions. Rerun Studio runner setup to verify and restart the lane."
