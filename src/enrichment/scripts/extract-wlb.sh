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

PROMPT=$(cat <<'EOF'
You are extracting a work-life-balance assessment from a company review page's content (e.g. Glassdoor), piped to you via stdin. Base your answer only on the provided content — do not browse or search for anything else.

Extract:
- "wlbScore": a number from 0 (poor work-life balance / burnout culture) to 1 (excellent work-life balance)
- "wlbNotes": a concise 1-3 sentence summary of what reviewers say about hours, burnout, and culture

Respond with ONLY a JSON object, no markdown fence, no commentary: {"wlbScore": number|null, "wlbNotes": string|null}
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json
