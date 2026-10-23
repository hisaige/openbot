#!/usr/bin/env bash
# One-shot: re-register the openbot pm2 app against scripts/openbot-launch.sh, so every later
# `pm2 restart openbot` reloads the model env from ~/.claude/settings.json (tt-switch writes it).
#
# Two reasons this exists:
#  1. `pm2 restart --update-env` copies the *calling shell's* env. Restarting from inside a bot
#     shell feeds the previous brain's env straight back in, so the old model aliases survive.
#  2. The bot harness runs with `settingSources: []`: ~/.claude/settings.json is never read by a
#     bot. scripts/openbot-launch.sh therefore reads it and exports the values before the brain
#     starts.
#
# Must not run as a child of the brain it replaces (the shutdown watchdog kills the process
# group), so scripts/restart-openbot.sh starts it through a transient systemd unit.
set -uo pipefail
LOG=/tmp/openbot-reregister.log
exec >>"$LOG" 2>&1

echo "=== $(date -Iseconds) re-registering openbot ==="

# Carry the running brain's non-session environment forward verbatim, so nothing but the model
# set changes. Model vars included: the launcher unsets and re-derives them on every start.
BRAIN_PID=$(pgrep -f "bun src/main.ts" | head -1)
if [ -n "${BRAIN_PID:-}" ]; then
  python3 - "$BRAIN_PID" > /tmp/openbot-baseline-env.sh <<'PY'
import shlex, sys

skip = {"PWD", "OLDPWD", "SHLVL", "_", "PM2_HOME", "PM2_USAGE", "NODE_APP_INSTANCE",
        "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"}
try:
    raw = open(f"/proc/{sys.argv[1]}/environ", "rb").read().split(b"\0")
except OSError:
    raw = []
for item in raw:
    if not item or b"=" not in item:
        continue
    key, value = item.split(b"=", 1)
    key = key.decode("utf-8", "replace")
    if key in skip or key.startswith("pm_") or key.startswith("BASH_FUNC"):
        continue
    print(f"export {key}={shlex.quote(value.decode('utf-8', 'replace'))}")
PY
  echo "baseline env from pid $BRAIN_PID: $(grep -c '^export' /tmp/openbot-baseline-env.sh) vars"
else
  echo "no running brain found; starting with a minimal env"
  : > /tmp/openbot-baseline-env.sh
fi

export PM2_HOME=/root/.pm2
export PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
# shellcheck disable=SC1091
. /tmp/openbot-baseline-env.sh
set +a

pm2 delete openbot
pm2 start /root/ai/openbot/scripts/ecosystem.config.cjs
sleep 5
pm2 save

echo "=== done $(date -Iseconds) ==="
pm2 list
echo "--- new brain env (model vars) ---"
NEW_PID=$(pgrep -f "bun src/main.ts" | head -1)
if [ -n "${NEW_PID:-}" ]; then
  tr '\0' '\n' < "/proc/$NEW_PID/environ" | grep -E "^(ANTHROPIC_DEFAULT|CLAUDE_CODE_SUBAGENT)" | sort
fi
