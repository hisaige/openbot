#!/usr/bin/env bash
# One-shot re-registration of the openbot pm2 app, so that from now on a plain
# `pm2 restart openbot` reloads the model set from ~/.claude/settings.json.
#
# Why this is needed:
#  1. `pm2 restart --update-env` copies the env of the shell you type it in. Restarting from a
#     shell that belongs to a running bot feeds the old brain's env straight back in, so the old
#     model aliases survive - exactly the symptom this fixes.
#  2. The bot harness runs Claude with `settingSources: []`, so ~/.claude/settings.json is never
#     read by a bot. scripts/openbot-launch.sh reads it and exports ANTHROPIC_* before the brain
#     starts, which is what makes (1) irrelevant afterwards.
#
# `pm2 delete openbot` stops the brain this script may be descended from, and the brain's shutdown
# watchdog kills its process group. Run it from a shell that is not a child of the brain (a normal
# terminal, not an OpenBot tool call).
set -uo pipefail
LOG=/tmp/openbot-reregister.log
exec >>"$LOG" 2>&1

REPO=/root/ai/openbot
echo "=== $(date -Iseconds) re-registering openbot ==="

# Take the running app's env as the baseline so only the model set changes. pm2's stored env is
# authoritative here; /proc is the fallback when pm2 has no record.
BASELINE=/tmp/openbot-baseline-env.sh
python3 - "$BASELINE" <<'PY'
import shlex, subprocess, sys

out = sys.argv[1]

def usable(key: str) -> bool:
    if not key or key in {"PWD", "OLDPWD", "SHLVL", "_", "PM2_HOME", "PM2_USAGE", "NODE_APP_INSTANCE"}:
        return False
    if key[0].islower() or key.startswith("BASH_FUNC") or key.startswith("_"):
        return False
    # Session identity of whatever shell launched this: must never reach the new brain.
    if key == "CLAUDECODE" or key.startswith("CLAUDE_"):
        return False
    return True

env = {}
try:
    raw = subprocess.run(["pm2", "jlist"], capture_output=True, text=True, timeout=30,
                         env={"PM2_HOME": "/root/.pm2", "PATH": "/root/.nvm/versions/node/v24.19.0/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"})
    import json
    for app in json.loads(raw.stdout or "[]"):
        if app.get("name") == "openbot":
            env = app.get("pm2_env", {})
            break
except Exception as exc:
    print(f"# pm2 jlist failed: {exc}", file=sys.stderr)

if not env:
    import glob
    pids = subprocess.run(["pgrep", "-f", "bun src/main.ts"], capture_output=True, text=True).stdout.split()
    if pids:
        try:
            blob = open(f"/proc/{pids[0]}/environ", "rb").read().split(b"\0")
            for item in blob:
                if b"=" in item:
                    k, v = item.split(b"=", 1)
                    env[k.decode()] = v.decode("utf-8", "replace")
        except OSError as exc:
            print(f"# cannot read brain env: {exc}", file=sys.stderr)

with open(out, "w") as fh:
    count = 0
    for key in sorted(env):
        if not usable(key):
            continue
        value = env[key]
        if isinstance(value, bool):
            value = "true" if value else "false"
        fh.write(f"export {key}={shlex.quote(str(value))}\n")
        count += 1
    print(f"# {count} baseline vars")
PY
echo "baseline: $(grep -c '^export' "$BASELINE" 2>/dev/null || echo 0) vars"

export PM2_HOME=/root/.pm2
export PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
# shellcheck disable=SC1091
. "$BASELINE"
set +a

cd "$REPO" || exit 1
pm2 delete openbot
pm2 start "$REPO/scripts/ecosystem.config.cjs"
sleep 8
pm2 save

echo "=== done $(date -Iseconds) ==="
pm2 list

echo "--- new brain model env ---"
NEW_PID=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a.get('name')=='openbot':
        print(a.get('pid') or '')
" 2>/dev/null)
if [ -n "${NEW_PID:-}" ] && [ -r "/proc/$NEW_PID/environ" ]; then
  tr '\0' '\n' < "/proc/$NEW_PID/environ" | grep -E "^(ANTHROPIC_DEFAULT|CLAUDE_CODE_SUBAGENT)" | sort
else
  echo "BRAIN NOT RUNNING - check /root/.pm2/logs/openbot-error.log" | tee -a /tmp/openbot-reregister.log
fi
