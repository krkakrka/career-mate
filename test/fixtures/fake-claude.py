#!/usr/bin/env python3
"""
A deterministic stand-in for the real `claude` binary, wired in via
CM_CLAUDE_BIN so the default test suite never makes a paid, networked,
nondeterministic call.

It is invoked exactly as the real thing is — `claude -p "<prompt>"
--output-format json [--allowedTools ...]` with the page text or context
JSON on stdin — and answers by recognising the prompt, so handlers,
scripts and the CLI all exercise their real code paths.

Python rather than shell on purpose: the shell version of this tripped over
its own text munging under `set -euo pipefail` (a `grep` matching nothing
exits 1 and aborts; `| head -1` on a link-heavy page raises SIGPIPE, which
`pipefail` then surfaces). A fixture whose entire purpose is to be
deterministic must not fail based on how many links a page happens to have.

Steering:
  CM_FAKE_CLAUDE_SCENARIO  force an envelope shape (empty, error, bad-json,
                           fail-exit, slow, no-sources)
  CM_FAKE_CLAUDE_LOG       append every invocation here, so a test can
                           assert what was called — or that nothing was
"""

import json
import os
import re
import sys
import time


def read_prompt(argv):
    for index, arg in enumerate(argv):
        if arg == '-p' and index + 1 < len(argv):
            return argv[index + 1]
    return ''


def requested_keys(text):
    """
    The top-level keys of the JSON shape the prompt asks for.

    Every prompt ends by declaring its exact response shape, so answering
    precisely those keys is what keeps the fake honest: `extract-structural.sh`
    asks only for the fields no deterministic rule could fill, and a fake
    that always returned all four would let a handler which ignored that
    subset pass offline and break against the real model.
    """
    match = re.search(r'(?:no commentary:|shape exactly:)\s*(\{.*)', text, re.S)
    if not match:
        return None

    keys, depth = [], 0
    for token in re.finditer(r'[{}]|"([A-Za-z_][A-Za-z0-9_]*)"\s*:', match.group(1)):
        if token.group(0) == '{':
            depth += 1
        elif token.group(0) == '}':
            depth -= 1
            if depth == 0:
                break
        elif depth == 1 and token.group(1):
            keys.append(token.group(1))
    return keys or None


def first_url(text):
    found = re.search(r'https?://[^\s)\'"]+', text)
    return found.group(0) if found else None


def answer_for(prompt, page):
    """
    Matched on wording unique to each prompt's *instruction* text, never on
    the caller-supplied context that follows it — a company described as
    "an AI company", or a role mentioning "salary", must not be able to
    steer the fake into answering a different question than the one asked.
    """
    scenario = os.environ.get('CM_FAKE_CLAUDE_SCENARIO', '')

    if 'still open and accepting applications' in prompt:
        closed = re.search(r'no longer|has closed|been filled|not accepting', page, re.I)
        state = 'closed' if closed else 'open'
        return {'status': state, 'reason': f'fake-claude: page reads as {state}'}

    if 'practical tips' in prompt:
        sources = [] if scenario == 'no-sources' else [{'url': 'https://example.com/a', 'title': 'A source'}]
        return {'content': 'Fake tips content.', 'sources': sources}

    if 'Find current, real, open job listings' in prompt:
        return {'roles': []}

    if 'job posting page' in prompt:
        return {
            'title': 'Senior Backend Engineer',
            'description': 'A fake-claude role description.',
            'companyName': 'Globex Corporation',
            'companyUrl': first_url(page),
        }

    if "company's own website" in prompt:
        return {'name': 'Globex Corporation', 'description': 'A fake-claude company description.'}

    # research-web.sh, matched on each kind's *own* declared fields rather
    # than on a shared trailing sentence. The three kinds are told apart by
    # what they ask for, which is the only thing that cannot drift when the
    # surrounding prose changes — an earlier version keyed the role half on
    # the word "aiProofScore", which appeared only because the scale
    # guidance mentioned a field that prompt had not requested.
    if 'wlbScore' in prompt:
        # CM_FAKE_CLAUDE_WLB shapes the answer, because the interesting WLB
        # cases are the *asymmetric* ones — a score with an unusable
        # confidence, or a confidence with no score — and the handler's
        # consistency rule cannot be tested against a fixture that always
        # returns both.
        variant = os.environ.get('CM_FAKE_CLAUDE_WLB', '')
        if variant == 'nothing-found':
            return {'wlbScore': None, 'wlbNotes': 'fake-claude: found almost nothing.', 'wlbConfidence': None}
        if variant == 'bad-confidence':
            return {'wlbScore': 0.3, 'wlbNotes': 'fake-claude note.', 'wlbConfidence': 'very high'}
        if variant == 'off-scale':
            # A model answering on a 0-10 scale, which clamping used to turn
            # into 1.0 — the best possible work-life balance.
            return {'wlbScore': 7, 'wlbNotes': 'fake-claude note.', 'wlbConfidence': 'high'}
        return {
            'wlbScore': 0.65,
            'wlbNotes': 'fake-claude: two Blind threads and one HN comment, all 2025 or later.',
            'wlbConfidence': 'medium',
        }

    if 'ipoStatus' in prompt or 'aiProofScore' in prompt:
        return {'ipoStatus': 'private', 'aiProofScore': 0.7, 'aiProofNotes': 'fake-claude note.'}

    if 'salaryMin' in prompt or 'equity' in prompt or 'remoteEu' in prompt:
        return {'salaryMin': 90000, 'salaryMax': 120000, 'equity': '0.05%', 'remoteEu': 'yes'}

    return None


def main():
    argv = sys.argv[1:]
    prompt = read_prompt(argv)
    page = sys.stdin.read()

    log_path = os.environ.get('CM_FAKE_CLAUDE_LOG')
    if log_path:
        with open(log_path, 'a', encoding='utf-8') as log:
            log.write(' '.join(argv) + '\n')

    scenario = os.environ.get('CM_FAKE_CLAUDE_SCENARIO', '')
    if scenario == 'error':
        print(json.dumps({'type': 'result', 'subtype': 'error', 'is_error': True, 'result': 'fake failure'}))
        return 0
    if scenario == 'bad-json':
        print('not json at all')
        return 0
    if scenario == 'fail-exit':
        print('fake-claude: deliberate failure', file=sys.stderr)
        return 1
    if scenario == 'slow':
        time.sleep(float(os.environ.get('CM_FAKE_CLAUDE_SLEEP', '600')))
        return 0

    answer = answer_for(prompt, page)
    if answer is None:
        # Refusing beats inventing: a prompt rewritten past recognition
        # should break loudly here, not quietly pass tests while the real
        # model gets an unanswerable question.
        print('fake-claude: unrecognised prompt, refusing to invent an answer', file=sys.stderr)
        print(f'prompt was: {prompt[:400]}', file=sys.stderr)
        return 2

    if scenario == 'empty':
        answer = {}
    else:
        wanted = requested_keys(prompt)
        if wanted is not None:
            answer = {key: value for key, value in answer.items() if key in wanted}

    print(json.dumps({
        'type': 'result',
        'subtype': 'success',
        'is_error': False,
        'result': json.dumps(answer),
        'total_cost_usd': 0.0012,
        'usage': {'input_tokens': 1234, 'output_tokens': 56},
        'modelUsage': {'claude-haiku-4-5-20251001': {'inputTokens': 1234, 'outputTokens': 56}},
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
