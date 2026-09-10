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

The original 14 steps are built. **Phase 2 — memoized data pipeline** (steps 15-22 in [PLAN.md](./PLAN.md)) is the current work: it changes how the tool handles data so that fetching is done once and remembered, the model is only called when an input actually changed, and every result is inspectable on disk. See PLAN.md for the step table (with a Status column) and design rationale — each step's row documents what was built, why, and what independent review caught along the way.

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
- **`--force` means one thing: take a new snapshot now.** It never overwrites derived data directly. `cm roles add <url>` on a URL you already track is a no-op that prints the existing role; `--force` refetches, and any derivation whose input changed becomes stale by definition.
- **Snapshot refresh policy is separate from staleness.** `settings.page_refresh_days` says how old a snapshot may be before `refresh`/`add` fetch again. Whether derived data matches that snapshot is the hash check above.
- **Priority score is computed on read**, never stored.
- **`claude` calls are sandboxed and budgeted**: extraction uses the cheapest model with no tools, research uses a mid-tier model with web search only, no user settings or hooks load inside the call, and each call has a turn limit, a dollar cap and a timeout. Fetched page content is untrusted input; those flags are what stop an instruction embedded in a job posting from reading local files or leaking them via a web search.

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
npm test           # run tests (vitest). Offline by default from Phase 2 step 21; until then several suites call the real `claude` CLI and take minutes
npm run test:live  # (from step 21) the suites that need a real `claude` login and network
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

**Delivery process**: each step in [PLAN.md](./PLAN.md) is implemented with tests first, then sent through an independent code review before committing — see [PLAN.md § Delivery process](./PLAN.md#delivery-process--commitable-steps).

## Project layout

```
career-mate/
  src/
    cli/           # commander CLI, one file per command group
    daemon/         # worker pool, job handlers
    db/             # migrations, WAL-mode client, repositories
    enrichment/     # claude-CLI-backed extraction scripts + source recipes
    pages/          # (Phase 2) page store: snapshot, hash, html→text
    derive/         # (Phase 2) derivation keys, staleness check, deterministic extractors
    browser/        # Playwright persistent-profile helpers (non-working path, see Status)
    scoring/         # priority score calculation
    reporting/       # cm status's pipeline digest query logic
    domain/          # small, pure, cross-cutting types/logic (job topics, entity
                      # correlation, preference matching) shared by the CLI and daemon
    notify/          # terminal / macOS notifications
    config/          # preferences, scoring weights, settings
  .data/            # gitignored — db, page snapshots, config, daemon log, browser profile, reference files
```
