#!/usr/bin/env bash
# Finds current open job listings at a company matching the user's preferences.
# Usage: research-discover.sh   (JSON context piped via stdin: {companyName, companyUrl, preferences})
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

CONTEXT=$(cat)

PROMPT=$(cat <<EOF
Find current, real, open job listings at this company that match the given preferences. Only include roles you can find an actual, working, specific posting URL for — never invent or guess a URL. If you find no matching open roles, return an empty list.

Context (JSON: company info + preferences): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary: {"roles": [{"title": string, "url": string}]}
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json \
  --model "$MODEL" --tools "WebSearch" --allowedTools "WebSearch" --setting-sources "" --strict-mcp-config --max-budget-usd "$BUDGET"
