#!/usr/bin/env bash
# Determines whether a job posting page is still open, from its already-
# fetched content. No web search — many ATS pages return HTTP 200 even for
# an expired posting (showing "no longer accepting applications" text
# instead of a 404), so this needs actual content judgment, not just the
# HTTP status (which the caller checks separately, before ever invoking
# this script — a real 404 doesn't need a claude call at all).
# Usage: extract-closure-status.sh   (page content piped via stdin)
set -euo pipefail

PROMPT=$(cat <<'EOF'
You are looking at a job posting page's content, piped to you via stdin. Determine whether this posting is still open and accepting applications, or has closed/expired/been filled. Base your answer only on the provided content — do not browse or search for anything else.

Respond with ONLY a JSON object, no markdown fence, no commentary: {"status": "open"|"closed"|"unknown", "reason": string|null}
Use "unknown" only if the content genuinely doesn't let you tell (e.g. it's not actually a job posting page at all, or it's empty/broken). "reason" should briefly explain what in the content led to your answer.
EOF
)

exec claude -p "$PROMPT" --output-format json
