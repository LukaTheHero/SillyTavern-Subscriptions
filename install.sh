#!/usr/bin/env bash
# Linux / macOS / Termux helper: install the plugin's dependencies and print a
# doctor report. Run from your SillyTavern directory (the one with server.js):
#
#   node plugins.js install https://github.com/LukaTheHero/SillyTavern-Subscriptions
#   bash plugins/SillyTavern-Subscriptions/install.sh
#
# Or from inside the plugin folder:  bash install.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

echo "== SillyTavern-Subscriptions installer =="
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required (18+). Termux: pkg install nodejs-lts ; Debian/Ubuntu: apt install nodejs npm ; macOS: brew install node" >&2
    exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
    echo "Node $(node --version) is too old — 18+ required." >&2
    exit 1
fi
echo "node $(node --version) on $(uname -s)/$(uname -m)${TERMUX_VERSION:+ (Termux $TERMUX_VERSION)}"

echo "-- npm install (with optional platform packages: the Claude CLI ships inside the Agent SDK)"
npm install --no-audit --no-fund --omit=dev --include=optional

# The Claude Code CLI comes from an optional per-platform package. A user-level
# `omit=optional` in ~/.npmrc drops it silently — check.
if ! node --input-type=module -e "const m = await import('./lib/claude/sdk-loader.js'); process.exit(m.claudeCliSummary().path ? 0 : 3)" 2>/dev/null; then
    if [ -n "${TERMUX_VERSION:-}" ] || [ "$(uname -o 2>/dev/null || true)" = "Android" ]; then
        echo "-- Termux note: Claude Code has no native Android build, so Claude cannot run directly on Termux."
        echo "   Run SillyTavern inside proot-distro (Debian/Ubuntu) for Claude, or set ST_SUBSCRIPTIONS_CLAUDE_PATH to a"
        echo "   claude binary known to run here. Codex and Gemini are unaffected."
    else
        echo "!! Claude Code CLI binary missing — check ~/.npmrc for omit=optional / optional=false and re-run this script." >&2
    fi
fi

echo "-- doctor"
node scripts/doctor.js || true

cat <<'EOF'

Done. Make sure SillyTavern's config.yaml has:  enableServerPlugins: true
Then start SillyTavern, hard-refresh the browser, open Extensions → Subscriptions → Connect.

Logins (run as the same OS user that runs SillyTavern):
  Claude   claude auth login       (or: claude setup-token → CLAUDE_CODE_OAUTH_TOKEN for headless boxes)
  Codex    codex login             (writes auth.json into the Codex home the CLI reports)
  Gemini   agy                     (sign in once interactively; Ctrl-C after the browser flow completes)
EOF
