#!/usr/bin/env bash
# Stands in for `claude -p --output-format json` so claude-extract.ts's
# envelope-parsing logic can be tested deterministically, without hitting
# the real model for every edge case.
# Usage: fake-claude-envelope.sh <scenario>
set -euo pipefail
SCENARIO="${1:-}"

case "$SCENARIO" in
  fenced)
    echo '{"type":"result","subtype":"success","is_error":false,"result":"```json\n{\"name\":\"Test Co\",\"description\":\"A test.\"}\n```"}'
    ;;
  unfenced)
    echo '{"type":"result","subtype":"success","is_error":false,"result":"{\"name\":\"Test Co\",\"description\":\"A test.\"}"}'
    ;;
  error)
    echo '{"type":"result","subtype":"error","is_error":true,"result":"something went wrong"}'
    ;;
  bad-json)
    echo 'not json at all'
    ;;
  bad-inner-json)
    echo '{"type":"result","is_error":false,"result":"this is not json"}'
    ;;
  null-result)
    echo '{"type":"result","is_error":false,"result":"null"}'
    ;;
  array-result)
    echo '{"type":"result","is_error":false,"result":"[1,2,3]"}'
    ;;
  fail-exit)
    echo "boom" >&2
    exit 1
    ;;
  *)
    echo "unknown scenario: $SCENARIO" >&2
    exit 1
    ;;
esac
