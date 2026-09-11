#!/usr/bin/env bash
# Extracts a WLB assessment from already-fetched (authenticated) page
# content — no web search here, unlike research-web.sh: this runs after
# src/browser/profile.ts's Playwright fetch already retrieved the specific
# login-gated page (e.g. Glassdoor reviews).
# Usage: extract-wlb.sh   (page content piped via stdin)
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
You are extracting a work-life-balance assessment from a company review page's content (e.g. Glassdoor), piped to you via stdin. Base your answer only on the provided content — do not browse or search for anything else.

Extract:
- "wlbScore": a number from 0 (poor work-life balance / burnout culture) to 1 (excellent work-life balance)
- "wlbNotes": a concise 1-3 sentence summary of what reviewers say about hours, burnout, and culture

Respond with ONLY a JSON object, no markdown fence, no commentary: {"wlbScore": number|null, "wlbNotes": string|null}
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json \
  --model "$MODEL" --tools "" --setting-sources "" --strict-mcp-config --max-budget-usd "$BUDGET"
