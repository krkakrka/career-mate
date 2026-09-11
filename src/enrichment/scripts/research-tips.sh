#!/usr/bin/env bash
# Multi-source "how to approach this" research, with mandatory citations.
# Usage: research-tips.sh <company|role>   (JSON context piped via stdin)
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
CONTEXT=$(cat)

case "$KIND" in
  company)
    PROMPT=$(cat <<EOF
Research and summarize practical tips for approaching a job application and interview at this company: culture, typical interview process and stages, what they value in candidates, negotiation norms, and general employee sentiment — drawing on sources like Glassdoor, Reddit, Blind, or similar public discussion. Cite every source you actually used.

Context (JSON): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary: {"content": string, "sources": [{"url": string, "title": string}]}
"content" should be well-organized markdown (a few short sections). "sources" MUST list every source you actually used to write it — omit none, and don't list sources you didn't use.
EOF
)
    ;;
  role)
    PROMPT=$(cat <<EOF
Research and summarize practical tips SPECIFIC to this role or team, beyond the general company-level tips already gathered (given below as context) — team-specific interview stages if discoverable, what this team/role seems to value, and anything else useful for approaching this particular opening. Cite every source you actually used. If nothing role-specific turns up beyond the general company info, say so briefly rather than padding.

Context (JSON, includes prior company-level tips plus role details): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary: {"content": string, "sources": [{"url": string, "title": string}]}
EOF
)
    ;;
  *)
    echo "usage: research-tips.sh <company|role>  (context piped via stdin)" >&2
    exit 1
    ;;
esac

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json \
  --model "$MODEL" --tools "WebSearch" --allowedTools "WebSearch" --setting-sources "" --strict-mcp-config --max-budget-usd "$BUDGET"
