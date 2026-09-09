#!/usr/bin/env bash
# Finds current open job listings at a company matching the user's preferences.
# Usage: research-discover.sh   (JSON context piped via stdin: {companyName, companyUrl, preferences})
set -euo pipefail

CONTEXT=$(cat)

PROMPT=$(cat <<EOF
Find current, real, open job listings at this company that match the given preferences. Only include roles you can find an actual, working, specific posting URL for — never invent or guess a URL. If you find no matching open roles, return an empty list.

Context (JSON: company info + preferences): ${CONTEXT}

Respond with ONLY a JSON object, no markdown fence, no commentary: {"roles": [{"title": string, "url": string}]}
EOF
)

exec claude -p "$PROMPT" --output-format json --allowedTools "WebSearch"
