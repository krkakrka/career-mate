#!/usr/bin/env bash
# Open-ended web research via claude -p with WebSearch explicitly granted
# (verified empirically: claude -p does NOT get WebSearch by default in
# headless mode — without --allowedTools it silently answers from trained
# knowledge and fabricates a plausible-looking source, rather than actually
# searching).
# Usage: research-web.sh <role|company> <instructions>   (JSON context piped via stdin)
set -euo pipefail

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

exec claude -p "$PROMPT" --output-format json --allowedTools "WebSearch"
