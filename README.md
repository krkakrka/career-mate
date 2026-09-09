# career-mate

A personal CLI tool for tracking and enriching a job search pipeline — replacing a hand-maintained spreadsheet of companies, roles, salaries, statuses, and research notes.

## Why

Job hunting means tracking a lot of moving pieces: which companies you're targeting, which roles you've applied to, their status, the compensation research, work-life-balance signals, and the CV/answers you used for each application. Doing this in a spreadsheet is slow and error-prone. `career-mate` (`cm`) owns this whole pipeline instead:

- Tracks companies and roles with full status history.
- Auto-fetches company/role details from a URL when you add them.
- Enriches roles and companies with researched data — compensation, equity, IPO status, remote/EU availability, AI-proofness, and work-life balance.
- Periodically re-checks saved role URLs and flags closures.
- Scores and ranks roles by a weighted priority formula tuned to your own preferences.
- Surfaces decision-support nudges: stale roles, overdue recruiter follow-ups, reapply cooldowns, duplicate detection.
- Generates on-demand, cited "tips" research (interview prep, culture, comp) per company or role.

Every action and periodic job is timestamped and logged for later debugging.

## Status

Early build-out, in progress. See [PLAN.md](./PLAN.md) for the full step-by-step delivery plan (13 steps, with a Status column tracking what's done) and design rationale. Currently through **Step 8 — browser automation, full enrichment, priority scoring**. Requires `npx playwright install chromium` once after `npm install` (not yet wired as an automatic postinstall step).

## How it works

```
CLI (thin client) → SQLite → Daemon → Worker pool → Enrichment scripts → claude CLI / Playwright
```

- **CLI**: a `commander`-based tool (`cm`) that writes rows directly to SQLite and enqueues background jobs.
- **SQLite (WAL mode)** is the only IPC channel between the CLI and the daemon — no socket or RPC layer needed, since WAL mode allows concurrent readers alongside one writer.
- **Daemon**: auto-started on demand by the CLI, runs a worker pool that polls the `jobs` table by topic (`enrichment`, `notification`, `refresh`, `discovery`, `tips`), each with its own concurrency (enrichment is serialized to 1, since it owns a single real browser).
- **Enrichment** runs through the `claude` CLI (`claude -p "<prompt>" --output-format json`) rather than the Anthropic API directly, so there's no API key management and prompts live in editable `.sh` scripts.
- **Login-gated research** (Glassdoor, etc.) uses Playwright against a dedicated persistent browser profile — log in once via `cm auth login-browser`, and later fetches run headlessly, already authenticated.

All data lives under `.data/` (gitignored): the SQLite database, the browser profile, and per-role reference files (CVs, application answers).

## Planned commands

```
cm companies add/list/show/set-preference/set-connections
cm roles add/list/show/set-status/set-reapply
cm recruiters ping/respond/list
cm interview-note add
cm tips <role-id>
cm refresh
cm discover
cm status
cm auth login-browser
cm inbox / cm inbox ack
cm events <id>
cm daemon / cm worker
```

Explicitly out of scope for this build: CV/PDF generation, and scheduled (launchd) periodic runs — `refresh`/`discover` are manual-only for now.

## Data model

SQLite tables: `companies`, `roles`, `role_status_history`, `role_references`, `tips`, `recruiter_contacts`, `interview_notes`, `events` (immutable audit log), `notifications`, `jobs` (the job queue). (Named `role_references`, not `references` — the latter is a SQL keyword.)

Hand-tuned config lives in `src/config/*.json`: `preferences.json` (role-matching filters), `scoring.json` (priority-score weights), `settings.json` (nudge/staleness thresholds), and `src/enrichment/sources.json` (per-data-source fetch recipes).

Full schema and field-level detail: see [PLAN.md § Data model](./PLAN.md#data-model-sqlite).

## Development

```bash
npm install
npm test           # run tests (vitest)
npm run test:watch
npm run typecheck  # tsc --noEmit
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
    browser/        # Playwright persistent-profile helpers
    scoring/         # priority score calculation
    notify/          # terminal / macOS notifications
    config/          # preferences, scoring weights, settings
  .data/            # gitignored — db, browser profile, reference files
```
