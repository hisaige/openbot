#!/usr/bin/env bash
# OpenBot brain launcher.
#
# Why this exists: the bot harness runs with `settingSources: []`, so Claude Code's own
# ~/.claude/settings.json is never read by the bots themselves. tt-switch (the local model proxy)
# keeps that file's `env` block current whenever the owner switches provider or model. This
# launcher reads those values and exports them before starting the brain, so the model set is
# always whatever tt-switch last wrote and a plain `pm2 restart openbot` picks it up.
#
# Only the model/backend variables below are taken from settings.json. Everything else the brain
# runs with (PAT on PATH, CODEBUDDY_*, AUTO_MODE_*, …) is left exactly as the parent provided.
set -euo pipefail

SETTINGS="${OPENBOT_MODEL_SETTINGS:-$HOME/.claude/settings.json}"
BRAIN_ENTRY="/root/ai/openbot/apps/server/src/main.ts"
BUN="/root/.bun/bin/bun"

# Claude Code variables whose value is model/backend config: settings.json is the only authority.
MANAGED_CLAUDE_CODE_VARS=(
  CLAUDE_CODE_SUBAGENT_MODEL
  CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL
  CLAUDE_CODE_MAX_CONTEXT_TOKENS
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
)

# Reads settings.json `env` and prints `export K=V` lines for the managed variables.
model_env() {
  python3 - "$SETTINGS" <<'PY'
import json, shlex, sys

try:
    with open(sys.argv[1]) as fh:
        env = json.load(fh).get("env") or {}
except Exception as exc:  # missing or malformed: keep the inherited env rather than boot blind
    print(f"openbot-launch: cannot read {sys.argv[1]}: {exc}; keeping inherited model env",
          file=sys.stderr)
    raise SystemExit

managed = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION",
)
for key in sorted(env):
    if key.startswith("ANTHROPIC_") or key in managed:
        print(f"export {key}={shlex.quote(str(env[key]))}")
PY
}

if [ "${1:-}" = "--print-env" ]; then
  model_env
  exit 0
fi

# Drop stale values first: an alias settings.json no longer mentions must not survive by
# inheritance (that is how a "restarted but still the old model" state happens).
while IFS= read -r name; do
  unset "$name"
done < <(env | cut -d= -f1 | grep -E '^ANTHROPIC_[A-Z0-9_]+$')
for name in "${MANAGED_CLAUDE_CODE_VARS[@]}"; do
  unset "$name"
done

eval "$(model_env)"

cd /root/ai/openbot/apps/server
exec "$BUN" "$BRAIN_ENTRY" "$@"
