#!/usr/bin/env bash
# Open-ended web research via claude -p with WebSearch explicitly granted
# (verified empirically: claude -p does NOT get WebSearch by default in
# headless mode — without --allowedTools it silently answers from trained
# knowledge and fabricates a plausible-looking source, rather than actually
# searching).
# Usage: research-web.sh <role|company> <instructions>   (JSON context piped via stdin)
set -euo pipefail

# The `claude` binary to run. Overridable so the test suite can substitute a
# deterministic stand-in: without it every test that touches extraction is a
# live, paid, network-dependent call, which is what kept real bugs hidden in
# the noise of an intermittently failing suite.
CLAUDE_BIN="${CM_CLAUDE_BIN:-claude}"

# Cheapest adequate model, and nothing it does not need.
#
# Fetched page content is untrusted input: a job posting can contain text
# shaped like an instruction. These flags are what stop such an instruction
# reaching anything worth reaching — `--tools ""` leaves the model no tools
# at all (research scripts grant WebSearch and nothing else),
# `--setting-sources ""` ignores user/project/local settings so no hook or
# custom agent is picked up, and `--strict-mcp-config` skips every MCP
# server. `--max-budget-usd` caps what a single call can spend.
#
# `--tools` and `--allowedTools` are BOTH required and are not the same
# thing: `--tools` decides which tools exist, `--allowedTools` decides which
# may be used without asking. With only `--tools WebSearch` the model
# answers "I don't have permission to use web search" and falls back to
# trained knowledge — verified directly, and the same silent-fallback trap
# Step 8 hit from the other direction.
#
# (The plan also called for `--max-turns`; no such flag exists in the
# `claude` CLI as of 2.1.268, so it is deliberately absent rather than
# guessed at.)
MODEL="sonnet"
BUDGET="${CM_MAX_BUDGET_USD:-0.50}"

KIND="${1:-}"
INSTRUCTIONS="${2:-}"
CONTEXT=$(cat)

case "$KIND" in
  role)
    SCHEMA='{"salaryMin": number|null, "salaryMax": number|null, "equity": string|null, "remoteEu": "yes"|"no"|"unknown"}'
    ;;
  company)
    SCHEMA='{"ipoStatus": string|null, "aiProofScore": number|null, "aiProofNotes": string|null}'
    ;;
  *)
    echo "usage: research-web.sh <role|company> <instructions>  (context piped via stdin)" >&2
    exit 1
    ;;
esac

PROMPT=$(cat <<EOF
${INSTRUCTIONS}

Context (JSON): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary, matching this shape exactly: ${SCHEMA}
Use null for any field you cannot confidently determine from real sources you found. For aiProofScore, use a number from 0 (highly automatable / at risk) to 1 (durably needs human judgment or skill).
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json \
  --model "$MODEL" --tools "WebSearch" --allowedTools "WebSearch" --setting-sources "" --strict-mcp-config --max-budget-usd "$BUDGET"
