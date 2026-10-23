#!/usr/bin/env bash
# OpenBot brain launcher.
#
# The bot harness runs with `settingSources: []`, so Claude Code's own
# ~/.claude/settings.json is never read by the bots themselves. tt-switch (the
# local model proxy UI) keeps that file's `env` block up to date whenever the
# owner switches provider/model. This launcher reads those values and exports
# them before starting the brain, so the model set is always whatever tt-switch
# last wrote - a plain `pm2 restart openbot` is enough to pick it up.
set -euo pipefail

SETTINGS="${OPENBOT_MODEL_SETTINGS:-$HOME/.claude/settings.json}"

model_env() {
  python3 - "$SETTINGS" <<'PY'
import json, os, shlex, sys

path = sys.argv[1]
try:
    with open(path) as fh:
        env = json.load(fh).get("env") or {}
except Exception:
    sys.exit(0)

wanted = [k for k in env if k.startswith("ANTHROPIC_") or k.startswith("CLAUDE_CODE_")]
# Vars that leak a parent session and must never reach the brain.
drop = {"CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDECODE"}
for key in sorted(wanted):
    if key in drop:
        continue
    print(f"export {key}={shlex.quote(str(env[key]))}")
PY
}

if [ "${1:-}" = "--print-env" ]; then
  model_env
  exit 0
fi

# Drop whatever the launching shell inherited from an earlier brain/harness process, so an alias
# settings.json no longer mentions cannot survive by inheritance alone.
while IFS= read -r name; do
  unset "$name"
done < <(env | cut -d= -f1 | grep -E '^(ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]+$')

eval "$(model_env)"

cd /root/ai/openbot/apps/server
exec /root/.bun/bin/bun src/main.ts "$@"
