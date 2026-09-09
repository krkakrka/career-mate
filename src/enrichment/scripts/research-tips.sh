#!/usr/bin/env bash
# Multi-source "how to approach this" research, with mandatory citations.
# Usage: research-tips.sh <company|role>   (JSON context piped via stdin)
set -euo pipefail

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

exec claude -p "$PROMPT" --output-format json --allowedTools "WebSearch"
