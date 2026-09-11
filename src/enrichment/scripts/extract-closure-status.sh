#!/usr/bin/env bash
# Determines whether a job posting page is still open, from its already-
# fetched content. No web search — many ATS pages return HTTP 200 even for
# an expired posting (showing "no longer accepting applications" text
# instead of a 404), so this needs actual content judgment, not just the
# HTTP status (which the caller checks separately, before ever invoking
# this script — a real 404 doesn't need a claude call at all).
# Usage: extract-closure-status.sh   (page content piped via stdin)
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
# (The plan also called for `--max-turns`; no such flag exists in the
# `claude` CLI as of 2.1.268, so it is deliberately absent rather than
# guessed at.)
MODEL="haiku"
BUDGET="${CM_MAX_BUDGET_USD:-0.50}"

PROMPT=$(cat <<'EOF'
You are looking at a job posting page's content, piped to you via stdin. Determine whether this posting is still open and accepting applications, or has closed/expired/been filled. Base your answer only on the provided content — do not browse or search for anything else.

Respond with ONLY a JSON object, no markdown fence, no commentary: {"status": "open"|"closed"|"unknown", "reason": string|null}
Use "unknown" only if the content genuinely doesn't let you tell (e.g. it's not actually a job posting page at all, or it's empty/broken). "reason" should briefly explain what in the content led to your answer.
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json \
  --model "$MODEL" --tools "" --setting-sources "" --strict-mcp-config --max-budget-usd "$BUDGET"
