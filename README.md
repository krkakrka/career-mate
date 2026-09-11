# career-mate

A personal CLI tool for tracking and enriching a job search pipeline — replacing a hand-maintained spreadsheet of companies, roles, salaries, statuses, and research notes.

## Why

Job hunting means tracking a lot of moving pieces: which companies you're targeting, which roles you've applied to, their status, the compensation research, work-life-balance signals, and the CV/answers you used for each application. Doing this in a spreadsheet is slow and error-prone. `career-mate` (`cm`) owns this whole pipeline instead:

- Tracks companies and roles with full status history.
- Auto-fetches company/role details from a URL when you add them.
- Enriches roles and companies with researched data — compensation, equity, IPO status, remote/EU availability, AI-proofness, and work-life balance.
- On-demand `cm refresh`/`cm discover`: re-checks saved role URLs for closure, and scans tracked companies for new matching roles.
- Scores and ranks roles by a weighted priority formula tuned to your own preferences.
- Surfaces decision-support nudges via `cm status`: stale roles, overdue recruiter follow-ups, reapply cooldowns, duplicate detection.
- Generates on-demand, cited "tips" research (interview prep, culture, comp) per company or role.

Every CLI action, daemon event, and job's full lifecycle is durably logged (`cm logs`, `cm worker jobs/failed/retry`) for later debugging, with secrets and raw page content redacted before they ever reach storage.

## Status

All 22 steps are built: the original 14, plus **Phase 2 — memoized data pipeline** (steps 15-22), which changed how the tool handles data so that fetching is done once and remembered, the model is called only when an input actually changed, and every result is inspectable on disk. See [PLAN.md](./PLAN.md) for the step table and design rationale — each row documents what was built, why, and what independent review caught along the way, including several real bugs (a derivation that could claim work it hadn't done, a prompt change that silently broke company resolution, a flag change that silently disabled web search).

Known non-working path: login-gated research (Glassdoor via Playwright). The WLB job short-circuits because no `urlTemplate` is configured, and Google sign-in inside an automated browser is refused by Google, so `cm auth login-browser` cannot complete a Google-backed login. It is deprioritized; see the Phase 2 backlog for the replacement.

## How it works

```
CLI (thin client) → SQLite → Daemon → Worker pool → Enrichment scripts → claude CLI / Playwright
```

- **CLI**: a `commander`-based tool (`cm`) that writes rows directly to SQLite and enqueues background jobs.
- **SQLite (WAL mode)** is the only IPC channel between the CLI and the daemon — no socket or RPC layer needed, since WAL mode allows concurrent readers alongside one writer.
- **Daemon**: auto-started on demand by the CLI, runs a worker pool that polls the `jobs` table by topic (`enrichment`, `notification`, `refresh`, `discovery`, `tips`), each with its own concurrency (enrichment is serialized to 1, since it owns a single real browser).
- **Enrichment** runs through the `claude` CLI (`claude -p "<prompt>" --output-format json`) rather than the Anthropic API directly, so there's no API key management and prompts live in editable `.sh` scripts.
- **Login-gated research** (Glassdoor, etc.) was designed to use Playwright against a dedicated persistent browser profile. See Status above — it does not currently work and is being replaced.

### Data handling (Phase 2 model)

Think of it as a build system: sources, rules, outputs.

```
sync (fetch, no model)  →  derive (deterministic first, model only if needed)  →  view (cm show/list, stale markers)
```

- **Raw pages are immutable snapshots.** Every fetch writes `.data/pages/<sha256(url)>/<fetched-at>.html` and a text derivation beside it, plus a `page_snapshots` row with the content hash. Nothing is ever overwritten; refetching appends. You can `cat` or `diff` what the tool saw.
- **Deterministic derivations run first** and are free: HTML to text, `<title>`/`og:title`, HTTP 404/410, a closure-phrase list. The model only sees what those can't decide, and it sees text, not HTML.
- **Model-derived values remember their inputs.** Each (entity, kind) has a `derivations` row recording the input hash and the hash of the prompt script that produced it, plus the model used and what it cost.
- **Staleness is a hash comparison, done lazily on read.** If the newest snapshot or the prompt script no longer matches what a value was derived from, `cm roles show` prints the old value with `(stale)` and enqueues one recompute job (debounced). Nothing is recomputed eagerly; stale data is visible rather than silently wrong, and it heals itself when the daemon runs.
- **`--force` means: fetch this page again now, and re-derive from it.** `cm roles add <url>` on a URL you already track prints the existing role and exits 0; `--force` takes a fresh snapshot and re-runs extraction. (The original design had `--force` mean *only* "new snapshot", on the reasoning that a changed snapshot makes derivations stale by itself — but when the page hasn't changed, the new snapshot hashes the same and nothing recomputes, leaving no way at all to redo an extraction the model got wrong.)
- **Snapshot refresh policy is separate from staleness.** `settings.page_refresh_days` says how old a snapshot may be before `add`/`rerun-enrichment` fetch again. Whether derived data matches that snapshot is the hash check above. **`cm refresh` deliberately ignores it**: "has this posting closed?" is a question about the live page, and answering it from a three-day-old snapshot reports a closed role as open while costing the same as a real check.
- **Priority score is computed on read**, never stored — it was the only multi-input derivation (role + company + weights + preferences), so storing it meant any of those changing had to fan out a recompute. A `set-preference` now shows in the very next `cm roles list`.
- **`claude` calls are sandboxed and budgeted**: extraction uses haiku with `--tools ""`, research uses sonnet with web search only, `--setting-sources ""` and `--strict-mcp-config` keep user hooks, settings and MCP servers out of the call, and each has a dollar cap (`settings.claude_max_budget_usd`) and a hard timeout (`settings.claude_timeout_seconds`) and runs in an empty scratch directory. Fetched page content is untrusted input, and those flags are what stop an instruction embedded in a job posting from reading local files. Note the limit of that guarantee: extraction calls get no tools at all, but a *research* call has web search, and its prompt includes a role title/description that extraction derived from the posting — so attacker-controlled text can still influence what that call searches for. Narrowing it further would mean not passing extracted text into a tool-enabled call at all.
- **Spend is recorded per call** in an append-only `model_calls` ledger, and `cm status` reports 7- and 30-day totals. Failed calls count too — a call that hits its budget cap and exits non-zero has still been paid for.
- **The daemon looks after itself**: it logs crashes, requeues jobs a dead daemon left `running` (giving up on one that keeps killing it), exits when its data directory disappears, and exits after 30 idle minutes since the next `cm` command starts a fresh one.

All data lives under `.data/` (gitignored): the SQLite database, page snapshots, hand-tuned config, the daemon log, the browser profile, and per-role reference files (CVs, application answers).

## Commands

```
cm companies add/list/show/set-preference/set-connections
cm roles add/list/show/set-status/set-reapply     # add is idempotent; --force takes a new snapshot
cm recruiters ping/respond/list
cm interview-note add
cm tips <role-id>
cm refresh                 # re-check tracked roles for closure (fire-and-forget)
cm discover                # scan tracked companies for new matching roles (fire-and-forget)
cm status                  # pipeline digest: counts, stale roles, overdue follow-ups, reapply dates, model spend
cm auth login-browser
cm inbox / cm inbox ack
cm events <id>
cm logs                    # durable CLI/daemon/job diagnostics, with filtering and --follow
cm daemon / cm worker      # worker jobs/failed/retry/drain/status
```

Explicitly out of scope for this build: CV/PDF generation, and scheduled (launchd) periodic runs — `refresh`/`discover` are manual-only, triggered by you.

## Data model

SQLite tables: `companies`, `roles`, `role_status_history`, `role_references`, `tips`, `recruiter_contacts`, `interview_notes`, `events` (immutable audit log), `notifications`, `jobs` (the job queue), `operational_logs` (CLI/daemon/job diagnostics, `cm logs`), and from Phase 2 `page_snapshots` (one row per fetch, pointing at the file on disk) and `derivations` (input hash, recipe hash, model and cost per derived field group). (Named `role_references`, not `references` — the latter is a SQL keyword.)

Hand-tuned config lives in `.data/config/*.json`, auto-seeded with defaults the first time it's read: `preferences.json` (role-matching filters), `scoring.json` (priority-score weights), `settings.json` (nudge/staleness thresholds, snapshot refresh policy, model budget). Per-data-source research instructions live in `src/enrichment/sources.json`.

Full schema and field-level detail: see [PLAN.md § Data model](./PLAN.md#data-model-sqlite).

## Development

```bash
npm install
npm test           # offline, deterministic, free — ~40s. No network, no `claude` calls.
npm run test:live  # the `*.live.test.ts` suites: real `claude`, real network, minutes, costs money
npm run test:watch
npm run typecheck  # tsc --noEmit
```

No build step — `cm` runs the TypeScript source directly via `tsx` (see `bin/cm.js`).

To run `cm` from anywhere instead of `npx tsx bin/cm.js ...` inside the project directory:

```bash
npm link      # once, from the project root — installs the `cm` bin globally, symlinked to this checkout
cm --help     # now works from any directory
npm unlink -g career-mate   # to undo
```

**Stack**: TypeScript (Node, ESM) + `better-sqlite3` + `commander`. Tests use [Vitest](https://vitest.dev), primarily black-box: invoking the built `cm` binary against an isolated temp `.data` directory and asserting on stdout/exit code/DB state.

`npm test` points `CM_CLAUDE_BIN` at `test/fixtures/fake-claude.py`, a stand-in invoked exactly as the real binary is. It answers only the keys each prompt's declared response shape asks for, and refuses a prompt it doesn't recognise rather than inventing an answer — so a prompt rewritten past recognition breaks loudly instead of passing against a fake that would answer anything. The handful of tests that must exercise the real model are named `*.live.test.ts`.

**Delivery process**: each step in [PLAN.md](./PLAN.md) is implemented with tests first, then sent through an independent code review before committing — see [PLAN.md § Delivery process](./PLAN.md#delivery-process--commitable-steps).

## Project layout

```
career-mate/
  src/
    cli/           # commander CLI, one file per command group
    daemon/         # worker pool, job handlers
    db/             # migrations, WAL-mode client, repositories
    enrichment/     # claude-CLI-backed extraction scripts + source recipes
    pages/          # page store: snapshot, hash, html→text
    derive/         # derivation keys + recipes, staleness, deterministic extractors
    browser/        # Playwright persistent-profile helpers (non-working path, see Status)
    scoring/         # priority score calculation
    reporting/       # cm status's pipeline digest query logic
    domain/          # small, pure, cross-cutting types/logic (job topics, entity
                      # correlation, preference matching) shared by the CLI and daemon
    notify/          # terminal / macOS notifications
    config/          # preferences, scoring weights, settings
  .data/            # gitignored — db, page snapshots, config, daemon log, browser profile, reference files
```
