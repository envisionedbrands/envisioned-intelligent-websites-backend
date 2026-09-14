#!/bin/bash
# setup-studio-runner.sh — install the Content Studio runner on this Mac.
#
# 1. Proves that the canonical backend and local service credential belong to
#    the same Supabase project.
# 2. Creates this Home's isolated, pinned yt-dlp/EJS toolchain.
# 3. Installs + loads the persistent per-Home launchd job.
#
# Run from the backend repo root:  bash scripts/setup-studio-runner.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$HOME/.config/digital-home"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
LAUNCH_DOMAIN="gui/$(id -u)"

if [ ! -f "$REPO_DIR/.env.local" ]; then
  echo "Missing $REPO_DIR/.env.local — the runner cannot start without the Digital Home environment."
  exit 1
fi
if ! /usr/bin/grep -Eq '^STUDIO_BACKEND_URL=https://' "$REPO_DIR/.env.local"; then
  echo "STUDIO_BACKEND_URL is missing or not HTTPS. Set it to the canonical deployed Digital Home backend URL."
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Studio video ingestion requires Node 22 or newer. Found: $($NODE_BIN --version)"
  exit 1
fi

FFMPEG_BIN="$(command -v ffmpeg || true)"
FFPROBE_BIN="$(command -v ffprobe || true)"
if [ -z "$FFMPEG_BIN" ] || [ -z "$FFPROBE_BIN" ]; then
  echo "Studio video transcription requires the ffmpeg and ffprobe binaries."
  echo "Install them (Homebrew: brew install ffmpeg), then rerun setup."
  exit 1
fi

# The runner owns identity normalization. Setup consumes its exact result so a
# self-hosted database port or future normalization change cannot split the
# launchd label/toolchain from the runtime lock and runner ID.
RUNNER_IDENTITY="$(
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" \
    "$REPO_DIR/scripts/studio-runner.mjs" --print-identity
)"
IFS=$'\t' read -r BACKEND_ORIGIN INSTANCE_ID <<< "$RUNNER_IDENTITY"
if [ -z "$BACKEND_ORIGIN" ] || ! [[ "$INSTANCE_ID" =~ ^[a-f0-9]{12}$ ]]; then
  echo "Studio runner could not derive a valid backend/database identity."
  exit 1
fi
LOCK_PORT="$(
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" \
    -p 'process.env.STUDIO_LOCK_PORT || ""'
)"
LABEL="com.digital-home.studio-runner.$INSTANCE_ID"
RUNNER_DIR="$CONFIG_DIR/studio-runners/$INSTANCE_ID"
VENV="$RUNNER_DIR/venv"
LOG_DIR="$RUNNER_DIR/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Pairing is the first network preflight and happens before any Python package
# or launchd state is changed. A copied .env.local cannot silently split work
# across two Homes.
STUDIO_FFMPEG_BIN="$FFMPEG_BIN" STUDIO_FFPROBE_BIN="$FFPROBE_BIN" \
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" "$REPO_DIR/scripts/studio-runner.mjs" --check-pairing

# Prove the deployed Worker's own secret and outbound Anthropic path. This is a
# separate zero-token check from the local runner key below: a copied local key
# cannot hide a missing/rejected Cloudflare Worker secret or intermediary block.
STUDIO_FFMPEG_BIN="$FFMPEG_BIN" STUDIO_FFPROBE_BIN="$FFPROBE_BIN" \
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" "$REPO_DIR/scripts/studio-runner.mjs" --check-worker-anthropic

# Prove the complete signed local carousel runtime before installing tools or
# starting launchd. Missing Chrome, templates, fonts or image assets must fail
# here, before this runner is capable of claiming HOUSE work.
STUDIO_FFMPEG_BIN="$FFMPEG_BIN" STUDIO_FFPROBE_BIN="$FFPROBE_BIN" \
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" "$REPO_DIR/scripts/studio-runner.mjs" --check-carousel

# Anthropic is a required local capability for the portable carousel renderer
# and uploaded-PDF reader. The setup agent owns consent and invokes the masked
# helper; this script never accepts the value through argv, stdin or logs.
HAS_ANTHROPIC_KEY="$(
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" \
    -p 'process.env.ANTHROPIC_API_KEY?.trim() ? "yes" : "no"'
)"
if [ "$HAS_ANTHROPIC_KEY" != "yes" ]; then
  echo ""
  echo "Required: Anthropic is not connected for Studio carousels and PDF reading."
  echo "Ask the Studio setup agent for consent, then store it from a local terminal with:"
  echo "  bash scripts/configure-studio-runner-secret.sh ANTHROPIC_API_KEY"
  echo "Rerun this setup after the key is stored. No secret should be pasted into chat."
  exit 1
fi
STUDIO_FFMPEG_BIN="$FFMPEG_BIN" STUDIO_FFPROBE_BIN="$FFPROBE_BIN" \
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" "$REPO_DIR/scripts/studio-runner.mjs" --check-anthropic

# fal is an optional capability, not a runner-wide prerequisite. The setup
# agent owns the consent-and-secret conversation before invoking this shell;
# the shell only reports the resulting capability. Keeping secrets out of an
# interactive subprocess also keeps them out of shell tracing and process
# arguments. Missing fal never blocks sources, desks, captioned video, uploads
# or carousels.
HAS_FAL_KEY="$(
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" \
    -p 'process.env.FAL_KEY?.trim() ? "yes" : "no"'
)"
if [ "$HAS_FAL_KEY" != "yes" ]; then
  echo ""
  echo "Optional: fal image generation is not connected."
  echo "Everything except Generate image will continue to work without it."
  echo "Ask the Studio setup agent to connect fal later, then rerun setup."
fi

mkdir -p "$LOG_DIR"
if [ ! -x "$VENV/bin/yt-dlp" ]; then
  echo "Creating this Home's yt-dlp venv at $VENV …"
  python3 -m venv "$VENV"
fi
# These exact, reviewed release pins replace the old shared floating updater.
# Setup for one Digital Home can no longer alter another Home's live tools.
"$VENV/bin/pip" install --quiet --upgrade \
  "yt-dlp[default,curl-cffi]==2026.8.19" \
  "yt-dlp-ejs==0.8.0" \
  "curl-cffi==0.16.2"
"$VENV/bin/pip" check --quiet
echo "yt-dlp: $("$VENV/bin/yt-dlp" --version)"

STUDIO_FFMPEG_BIN="$FFMPEG_BIN" STUDIO_FFPROBE_BIN="$FFPROBE_BIN" \
  "$NODE_BIN" --env-file="$REPO_DIR/.env.local" "$REPO_DIR/scripts/studio-runner.mjs" --check

# Retire legacy and earlier-origin services only when their WorkingDirectory
# is this exact repo. Other Homes' launch agents are never touched.
retire_same_repo_plist() {
  local candidate="$1"
  [ -f "$candidate" ] || return 0
  [ "$candidate" = "$PLIST" ] && return 0
  local candidate_repo
  candidate_repo="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$candidate" 2>/dev/null || true)"
  if [ "$candidate_repo" = "$REPO_DIR" ]; then
    launchctl bootout "$LAUNCH_DOMAIN" "$candidate" 2>/dev/null || true
    mv "$candidate" "$candidate.disabled.$INSTANCE_ID.$(date +%s)"
  fi
}

retire_same_repo_plist "$HOME/Library/LaunchAgents/com.digital-home.studio-runner.plist"
for OLD_PLIST in "$HOME"/Library/LaunchAgents/com.digital-home.studio-runner.*.plist; do
  retire_same_repo_plist "$OLD_PLIST"
done

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=$REPO_DIR/.env.local</string>
    <string>$REPO_DIR/scripts/studio-runner.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STUDIO_FFMPEG_BIN</key>
    <string>$FFMPEG_BIN</string>
    <key>STUDIO_FFPROBE_BIN</key>
    <string>$FFPROBE_BIN</string>
    <key>STUDIO_YTDLP_BIN</key>
    <string>$VENV/bin/yt-dlp</string>
    <key>STUDIO_PIP_BIN</key>
    <string>$VENV/bin/pip</string>
    <key>STUDIO_LOCK_PORT</key>
    <string>$LOCK_PORT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/studio-runner.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/studio-runner.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$LAUNCH_DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST"
launchctl kickstart -k "$LAUNCH_DOMAIN/$LABEL"
launchctl print "$LAUNCH_DOMAIN/$LABEL" >/dev/null
echo "Studio runner $INSTANCE_ID is loaded for $BACKEND_ORIGIN. Log: $LOG_DIR/studio-runner.log"
