# Working on career-mate

A personal job-search pipeline CLI. Read [README.md](./README.md) for what it does and
[PLAN.md](./PLAN.md) for how it got here — every step's row records what was built, why, and what
independent review caught.

These are the invariants that are easy to break and expensive to notice. Most of them exist because
something already went wrong.

## The data model is a build system

Sources (immutable page snapshots) → rules (deterministic first, model only for the remainder) →
outputs (values on `companies`/`roles`/`tips`, each with a `derivations` row recording what it was
computed from). Staleness is a hash comparison done on read. There is no dependency graph, no
invalidation cascade, no eager recompute pass — and adding one would be a significant design change,
not a fix.

## Never rewrite what is under `.data/pages/`

Snapshots are append-only. A re-fetch adds a row and, if the body changed, new files; an unchanged
body records the row and reuses the existing files. Nothing is edited or deleted in place, because
`page_snapshots.content_hash` is a claim about exactly those bytes, and the whole staleness model
rests on it. Filenames are claimed with `link()`+EEXIST rather than `existsSync`-then-write: two
workers really can collide in the same millisecond, and one row pointing at another row's content is
silent corruption.

If you change `deriveText`, understand that its output is hashed into `text_hash`. It is a versioned
format, not an incidental helper — changing it invalidates every page-based derivation.

## Record a derivation last, and in the same transaction as its effects

A `derivations` row is the claim "this input has been fully processed", and the next run skips the
model on the strength of it. Writing it before the effects have landed means a transient failure
leaves the claim true and the work undone — and the retry then skips everything, permanently. This
shipped once: a role stayed unresolved forever because the derivation was written before company
resolution ran.

Every model-derived field needs a `kind` in `DERIVATION_KINDS`. If you add a field group without
one, it can never be detected as stale and will never be recomputed.

**Build a derivation key in exactly one place.** The handler writes it and the read path
(`view-staleness.ts`) recomputes it to decide whether what is on screen is current. Two builders that
drift by so much as a key order hash differently *every* time, so the value reads `(stale)` forever
and every read enqueues a recompute that changes nothing. This shipped twice — once for the research
context (hence `research-context.ts`), once for the prefill half added on top of it (hence
`role-research-key.ts`). Add an input to a key by extending the shared builder, never inline at the
call site.

Spend is recorded separately, by `runTrackedExtraction`, **outside** any caller transaction and on
the failure path too. A call that hits its budget cap and exits non-zero has still been paid for, and
money already spent cannot be un-spent by a rollback.

## Never add a `claude` call without the safety flags

Every script runs `--model`, `--tools`, `--setting-sources ""`, `--strict-mcp-config` and
`--max-budget-usd`. Fetched page content is untrusted input — a job posting can contain text shaped
like an instruction — and these flags are what keep such an instruction from reaching anything worth
reaching.

Two specifics worth knowing before you touch them:

- **`--tools` and `--allowedTools` are not the same thing.** `--tools` decides which tools exist;
  `--allowedTools` decides which may be used without asking. Research scripts need *both*: with only
  `--tools WebSearch` the model answers "I don't have permission to use web search" and falls back to
  trained knowledge — silently, with every test still green.
- **`--max-turns` does not exist** in the `claude` CLI (checked at 2.1.268). Check `claude --help`
  before adding a flag; the plan called for that one and it isn't real.

Use `CM_CLAUDE_BIN` to substitute a binary. Never hardcode `claude`.

## Tests are offline by default

`npm test` must stay deterministic, free and under a minute. It points `CM_CLAUDE_BIN` at
`test/fixtures/fake-claude.py`. A new test that needs a model uses the fake; one that genuinely needs
the real thing is named `*.live.test.ts` and runs under `npm run test:live`.

The fake deliberately **refuses prompts it doesn't recognise**. If you rewrite a prompt and tests
start failing with "unrecognised prompt", that is the fixture doing its job — teach it the new
wording rather than making it answer anything.

An intermittently failing suite hides real bugs in its own noise. That is not hypothetical here: a
prompt regression that broke company resolution went unnoticed for several runs because a different
live test failed each time.

## Anything that touches `.data` in a test must set `CM_DATA_DIR`

Including handler unit tests — the page store resolves paths through `getDataDir()`, so a fixture
route that serves a 200 will otherwise write snapshots into the project's real `.data`. Restore it
with `restoreEnv`, never `process.env.X = undefined`, which sets the literal string `"undefined"`.

## Config files are hand-edited, so coerce everything

`loadJsonConfig` shallow-merges whatever JSON is on disk. Since priority is scored on the read path,
a bad `preferences.json` takes down `cm roles list` rather than just failing a background job. Every
field goes through `src/lib/config-coerce.ts`. A malformed value falls back to the default; the file
is never rewritten, because it is someone's hand-tuned state.

## Prefer a deterministic rule only where it beats the model

Free is not the same as better. The role-title prefill was dropped because ATS pages put boilerplate
in `<title>`/`og:title` ("Job Application for X at Acme"), and the model unwraps that correctly while
a regex does not. `og:site_name` → company name stays, because that markup genuinely is more
reliable than a model reading the page.

The same asymmetry governs the closure phrase list: a false *closed* verdict silently removes a live
role from your pipeline, while a missed phrase costs one model call. Only add a phrase that cannot
appear on a page whose posting is open.

## A number is not a value without its unit

`roles.salary_min`/`salary_max` are bare integers and `compFitTerm` compares `salary_max` to
`preferences.minSalary` as bare integers. ¥5,000,000 clears a €100,000 floor by a factor of fifty
while being about a third of it, and an hourly 80 stored as a salary reads as catastrophic — and
nothing downstream reads the score back to notice either.

So: a declared figure is only believed at `unitText: YEAR` and only in the currency
`preferences.currency` names, and `salary_min`, `salary_max` and `salary_currency` are written and
cleared **as a unit** — a call reporting any figure replaces all three, a call reporting none touches
none. `COALESCE`ing them independently mixes sources: a model answering a minimum but no maximum left
the *previous* declared maximum in place, and the maximum is the figure `compFitTerm` reads. Refuse
rather than convert — a stored conversion rate is stale the day after it is written.

## A recorded HAR is a credential

The browser profile exists to hold an *authenticated* session, so a HAR recorded through it contains
the live session cookie in plaintext — request `Cookie`, response `Set-Cookie`, and the HAR's own
`cookies` arrays — and `content: 'embed'` puts whole response bodies in there too. `cm auth
record-har` runs every recording through `redactHarSecrets` before the file reaches its destination,
and that costs the feature nothing: `routeFromHAR` matches on URL and method and serves the recorded
body, never reading those headers back. Redaction is not a general scrubber, though — a response that
prints a token in its own body still carries it, which is why the command says so every time.

Tracing follows the same rule from the other side: `cm auth login-browser` is never traced, whatever
`settings.browser_trace` says, because a trace is screenshots plus DOM snapshots and that command's
entire purpose is typing credentials into someone else's login form.

## `runCli` blocks the event loop, so no fixture server can be live during it

`test/helpers/run-cli.ts` uses `spawnSync`. That blocks the vitest worker's event loop — and an
in-process `startFixtureServer` lives on that same loop, so it cannot accept the subprocess's
connection and every request times out. The symptom is indistinguishable from a genuinely broken
network path, which is what makes it expensive: the first draft of `test/cli/auth.test.ts` took 145
seconds and failed six of seven tests this way.

Record what the subprocess needs *before* `runCli` (closing the server first), or drive the library
in-process instead.

## Delivery process

Each step: tests first, implement, then an independent review (`/code-review`), address every
finding, re-run tests, commit with the PLAN.md row updated in the same commit. The review gate is not
ceremony — it has caught a race, a silent data-corruption path, a crash loop, and two cases of a
change that would have quietly stopped working while every test passed.

If you hit a genuine contradiction between PLAN.md and what the code needs, update PLAN.md to record
the deviation and why. Do not silently diverge from it.
