#!/usr/bin/env bash
# Extracts structured data from the derived text of a company or role page.
# Usage: extract-structural.sh <company|role> [fields]   (derived page text piped via stdin)
#
# `fields` is an optional comma-separated subset to extract; omitted or
# empty means all of them. The caller passes only the fields a
# deterministic derivation could NOT fill (src/derive/structural.ts), so a
# title the page states in its own og:title never costs a model call — and
# the prompt genuinely omits it rather than asking and discarding.
#
# Prints claude -p's raw --output-format json envelope to stdout; the
# caller (src/enrichment/claude-extract.ts) unwraps .result and strips the
# markdown fence claude -p wraps JSON answers in.
set -euo pipefail

# The `claude` binary to run. Overridable so the test suite can substitute a
# deterministic stand-in: without it every test that touches extraction is a
# live, paid, network-dependent call, which is what kept real bugs hidden in
# the noise of an intermittently failing suite.
CLAUDE_BIN="${CM_CLAUDE_BIN:-claude}"

KIND="${1:-}"
FIELDS="${2:-}"

case "$KIND" in
  company)
    ALL_FIELDS="name,description"
    CONTEXT="the text of a company's own website (homepage or about page)"
    ;;
  role)
    ALL_FIELDS="title,description,companyName,companyUrl"
    CONTEXT="the text of a job posting page"
    ;;
  *)
    echo "usage: extract-structural.sh <company|role> [fields]  (derived page text piped via stdin)" >&2
    exit 1
    ;;
esac

[ -z "$FIELDS" ] && FIELDS="$ALL_FIELDS"

# What each field means. Kept in one place so the description a field gets
# is identical whether or not it is asked for alongside the others.
field_description() {
  case "$1" in
    name) echo '- "name": the company'"'"'s name' ;;
    title) echo '- "title": the job title' ;;
    description)
      if [ "$KIND" = company ]; then
        echo '- "description": a concise 1-3 sentence description of what the company does'
      else
        echo '- "description": a concise 2-4 sentence summary of the role and its responsibilities'
      fi
      ;;
    companyName) echo '- "companyName": the name of the company hiring, as stated on the page' ;;
    companyUrl)
      echo '- "companyUrl": the company'"'"'s own homepage URL. Take it from anywhere in the text: a link target, the header block, or a URL written as ordinary text (e.g. a line reading "Company homepage: https://..."). Prefer the company'"'"'s own domain over the job board or applicant-tracking-system domain the posting happens to be hosted on (e.g. boards.greenhouse.io, jobs.lever.co, myworkdayjobs.com, ashbyhq.com). If the page states a homepage URL anywhere, report it rather than returning null.'
      ;;
    *) echo "unknown field: $1" >&2; exit 1 ;;
  esac
}

DESCRIPTIONS=""
SHAPE=""
IFS=','
for FIELD in $FIELDS; do
  [ -z "$FIELD" ] && continue
  DESCRIPTIONS="${DESCRIPTIONS}$(field_description "$FIELD")
"
  [ -n "$SHAPE" ] && SHAPE="${SHAPE}, "
  SHAPE="${SHAPE}\"${FIELD}\": string|null"
done
unset IFS

if [ -z "$SHAPE" ]; then
  echo "extract-structural.sh: no fields requested" >&2
  exit 1
fi

PROMPT="You are extracting structured data from ${CONTEXT}, piped to you via stdin. The text is a plain-text rendering of the page: if the page declared any metadata it begins with a header block of \`key: value\` lines (title, canonical, og:*) followed by a blank line, then the page's visible text. Where the page contained a link, the link text is followed by its target in parentheses. URLs may equally appear as ordinary text anywhere in the page, with no link around them. Base your answer only on the provided content — do not browse or search for anything else.

Extract:
${DESCRIPTIONS}
Respond with ONLY a JSON object, no markdown fence, no commentary: {${SHAPE}}. Use null for any field you cannot confidently determine from the page content."

exec "$CLAUDE_BIN" -p "$PROMPT" --output-format json
