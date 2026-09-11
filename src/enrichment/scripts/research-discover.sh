#!/usr/bin/env bash
# Finds current open job listings at a company matching the user's preferences.
# Usage: research-discover.sh   (JSON context piped via stdin: {companyName, companyUrl, preferences})
set -euo pipefail

# The `claude` binary to run. Overridable so the test suite can substitute a
# deterministic stand-in: without it every test that touches extraction is a
# live, paid, network-dependent call, which is what kept real bugs hidden in
# the noise of an intermittently failing suite.
CLAUDE_BIN="${CM_CLAUDE_BIN:-claude}"

CONTEXT=$(cat)

PROMPT=$(cat <<EOF
Find current, real, open job listings at this company that match the given preferences. Only include roles you can find an actual, working, specific posting URL for — never invent or guess a URL. If you find no matching open roles, return an empty list.

Context (JSON: company info + preferences): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary: {"roles": [{"title": string, "url": string}]}
EOF
)

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json --allowedTools "WebSearch"
