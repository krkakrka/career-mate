#!/usr/bin/env bash
# Extracts structured data from a company or role page's HTML.
# Usage: extract-structural.sh <company|role>   (page HTML piped via stdin)
# Prints claude -p's raw --output-format json envelope to stdout; the
# caller (src/enrichment/claude-extract.ts) unwraps .result and strips the
# markdown fence claude -p wraps JSON answers in.
set -euo pipefail

KIND="${1:-}"

case "$KIND" in
  company)
    PROMPT=$(cat <<'EOF'
You are extracting structured data from a company's own website HTML (homepage or about page), piped to you via stdin. Base your answer only on the provided content — do not browse or search for anything else.

Extract:
- "name": the company's name
- "description": a concise 1-3 sentence description of what the company does

Respond with ONLY a JSON object, no markdown fence, no commentary: {"name": string|null, "description": string|null}. Use null for any field you cannot confidently determine from the page content.
EOF
    )
    ;;
  role)
    PROMPT=$(cat <<'EOF'
You are extracting structured data from a job posting page's HTML, piped to you via stdin. Base your answer only on the provided content — do not browse or search for anything else.

Extract:
- "title": the job title
- "description": a concise 2-4 sentence summary of the role and its responsibilities
- "companyName": the name of the company hiring, as stated on the page
- "companyUrl": the company's own homepage URL, if determinable from the page content or links. This must be the company's own domain, NOT the job board or applicant-tracking-system domain the posting happens to be hosted on (e.g. not boards.greenhouse.io, jobs.lever.co, myworkdayjobs.com, ashbyhq.com, etc.) unless that genuinely is the company's own domain.

Respond with ONLY a JSON object, no markdown fence, no commentary: {"title": string|null, "description": string|null, "companyName": string|null, "companyUrl": string|null}. Use null for any field you cannot confidently determine.
EOF
    )
    ;;
  *)
    echo "usage: extract-structural.sh <company|role>  (HTML piped via stdin)" >&2
    exit 1
    ;;
esac

exec claude -p "$PROMPT" --output-format json
