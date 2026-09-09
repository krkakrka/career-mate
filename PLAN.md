# career-mate — implementation plan

## Resuming this plan (read first)

If you're picking this up cold — new session, no memory of prior conversation — do this:

1. **Find the next step.** Open the step table under "Delivery process — commitable steps" below and find the first row marked `🔲 Not started`. That's what you're building next. Everything above it should already be `✅ Done`; if a gap looks suspicious (a done step depends on a not-started one), check `git log` before trusting the table.
2. **Read the commit history for context**, not just this file: `git log --oneline` shows one commit per step (plus the occasional standalone process/fix commit), and each commit *body* documents what was built, why specific decisions were made, and — critically — what the independent review caught and how it was fixed. Skimming the last 3-4 step commits' full messages (`git show <hash>`) before starting is worth it; several steps corrected real concurrency bugs that the next step's code needs to not reintroduce.
3. **Follow "Delivery process" below exactly** for the next step: write its tests, implement until green, run the independent review (the `code-review` skill, backgrounded), address every finding, re-run tests, commit — and update this file's Status column to `✅ Done` for that row as part of the same commit. Don't skip the review gate; it has caught real bugs (races, silent data corruption, a resource leak) in nearly every step so far, not style nits.
4. **Don't re-plan from scratch.** The step breakdown, data model, and architecture below are already decided (see "Context" for the why). Only deviate if you hit a genuine contradiction between the plan and what the codebase actually needs — and if you do, update this file to reflect the change, don't just silently diverge from it.

**If this file (`PLAN.md`) is missing or looks wrong:**

1. **Check git first — it's a tracked file, so "missing" usually means "deleted from the working tree, not from history."** Run `git log --all --oneline -- PLAN.md` to find its commits, then `git show <most-recent-hash>:PLAN.md > PLAN.md` to restore the latest version. Do this before attempting to reconstruct anything from scratch.
2. **If it's genuinely gone from git too** (fresh clone with squashed/missing history, or no `.git` at all), reconstruct it from, in order of authority: (a) `IDEA.md` — the original raw requirements; (b) `git log` commit messages — each step commit documents what was built, the key design decisions behind it, and what review fixes were applied, which is most of what this file's "Context"/"Architecture" sections below capture; (c) `README.md` — a current-state architecture summary; (d) the codebase and its tests as ground truth for what's actually implemented, since code can drift from docs. Rebuild the step table in commit order (each "Step N: ..." commit maps to one row) and mark everything already committed as `✅ Done`.
3. Once reconstructed, treat it as a draft — sanity-check the "Depends on" column and remaining-step descriptions still make sense against the real codebase before continuing.

## Context

Job hunting currently means maintaining a spreadsheet by hand: companies, roles, status, salary research, WLB signals — time-consuming and error-prone, and the "soft" research (comp, AI-proofness, work-life balance, interview prep tips) requires manually digging through Glassdoor, Reddit, levels.fyi, etc. The goal is a personal CLI tool that owns this whole pipeline: track companies/roles, auto-enrich them with researched data (including from login-gated sites, via your own authenticated session), score/sort by what actually matters to you, and surface a few decision-support features (staleness, duplicates, recruiter follow-up nudges, reapply cooldowns) so nothing falls through the cracks.

This is a greenfield project (repo currently contains only `IDEA.md`). Design was worked out over several rounds — key decisions and why:

- **TypeScript/Node + SQLite (WAL mode)**, data under `./.data/` (gitignored). SQLite is fully ACID and, in WAL mode, supports concurrent readers alongside one writer — which is what lets the CLI and daemon share the DB file safely with no IPC protocol needed.
- **Enrichment goes through the `claude` CLI, not the Anthropic API directly** — standalone `.sh` scripts under `src/enrichment/scripts/` call `claude -p "<prompt>" --output-format json`, so no API key management and prompts are editable independent of app code.
- **Login-gated research (Glassdoor, etc.) uses Playwright with a dedicated persistent browser profile** — a one-time `cm auth login-browser` command opens a visible browser against `.data/browser-profile/`, you log in manually once, and all later fetches from that profile run headlessly, already authenticated. (Ruled out `claude-in-chrome`: it requires an interactive session with the extension bridge attached and is explicitly disabled under API-key/headless auth — confirmed via research, not assumption.)
- **Decoupled architecture**: CLI (thin client) → writes rows to SQLite → Daemon (long-running, auto-started on demand) owns a worker pool that polls SQLite for jobs. The database *is* the only IPC channel — no socket/RPC layer. This gives real separation of concerns without inventing a wire protocol nobody needs yet.
- **Multi-topic job queue in one SQLite table** (not separate physical queues) — a `topic` column plus per-topic worker concurrency lets cheap/fast jobs (notifications) run without waiting behind slow/expensive ones (enrichment, which is serialized to 1 concurrent job since Playwright owns one real browser).
- **Scope**: full CRUD + status tracking + enrichment (comp, equity, IPO status, remote/EU, AI-proofness, WLB) + on-demand cited "tips" research + lightweight recruiter-contact tracking + weighted priority scoring (including a manual per-company preference rating) + pipeline digest/staleness flagging + reapply-cooldown + hard-block duplicate detection. **Explicitly out of scope for this build**: CV.md generation and PDF rendering (user will do this once they supply their experience data — deferred), and periodic/scheduled runs via launchd (refresh/discover are manual-only for now, launchd wiring is a later phase once proven).

## Project layout

```
career-mate/
  package.json                 # bin: "cm"
  tsconfig.json
  src/
    cli/                       # thin CLI (commander), one file per command group
      index.ts
      commands/{companies,roles,recruiters,tips,refresh,discover,status,auth,daemon,worker,events}.ts
    daemon/
      index.ts                 # entrypoint, PID file mgmt, auto-start-if-not-running helper
      worker-pool.ts           # per-topic concurrency manager, job claim/complete/retry loop
      handlers/{enrichment,notification,refresh,discovery,tips}.ts
    db/
      migrations/*.sql
      client.ts                 # better-sqlite3, WAL mode pragma
      repositories/{companies,roles,jobs,events,notifications,recruiter-contacts,interview-notes,references}.ts
    enrichment/
      scripts/*.sh               # each calls `claude -p ... --output-format json`
      sources.json                # declarative source recipes (see below)
    browser/
      profile.ts                 # Playwright launchPersistentContext helpers
    scoring/
      priority.ts                 # weighted composite score calculation
    notify/{terminal.ts,macos.ts}
    config/{preferences.json,scoring.json,settings.json}
  .data/                          # gitignored
    career-mate.db
    browser-profile/
    files/<role-id>/               # CVs, application-answer references
```

## Data model (SQLite)

- **companies**: id, url, name, description, preference_rating (-2..2, manual), connections (freeform text, manual — referral/who-you-know), ipo_status, ai_proof_score, ai_proof_notes, wlb_score, wlb_notes, last_enriched_at, created_at, updated_at.
  *(AI-proofness and WLB live on the company, not the role — they're properties of the employer, not the individual posting; this also lets Tips research be cached and reused across roles at the same company.)*
- **roles**: id, company_id, url, title, description, status (`new|todo|applied|interviewing|success|denied|skip`, unrestricted transitions — this is a personal tool, not a shared workflow, so no state-machine enforcement, just a well-defined value set), status_changed_at, reapply_after (nullable, auto-set to +1 month on `denied`, editable), salary_min, salary_max, equity, remote_eu, priority_score (computed), closed_at, last_checked_at, last_enriched_at, created_at, updated_at.
- **role_status_history**: id, role_id, from_status, to_status, changed_at, context (free text — the IDEA.md requirement that every action carries timestamp + context).
- **references**: id, role_id, type (`cv|application_answers|cover_letter|other`), file_path, notes, created_at. Files live under `.data/files/<role-id>/`.
- **tips**: id, scope (`company|role`), company_id (nullable), role_id (nullable), content (markdown), sources (JSON array of `{url, title}` — every source cited, no exceptions), generated_at.
- **recruiter_contacts**: id, role_id, recruiter_name, contacted_at, channel (open text), link, notes, responded_at (nullable — null + `contacted_at` older than `settings.recruiter_nudge_days` (default 7) = overdue for follow-up).
- **interview_notes**: id, role_id, stage (freeform), notes, occurred_at, created_at.
- **events**: id, entity_type, entity_id, type, context (JSON), occurred_at — immutable audit trail for every action and periodic-job run, per IDEA.md's debugging requirement.
- **notifications**: id, event_id (fk), channel, message, delivered_at, acknowledged_at (nullable) — the mutable "inbox" layer on top of the immutable events log; `cm inbox` reads unacknowledged rows.
- **jobs**: id, topic (`enrichment|notification|refresh|discovery|tips`), payload (JSON), status (`pending|running|done|failed`), priority, attempts, available_at (retry backoff), error, created_at, updated_at.

Config files (`src/config/*.json`, user-editable, not DB rows since they're low-volume and meant to be hand-tuned):
- `preferences.json` — single profile: title/keyword match, seniority, remote+EU required, min salary floor. Used by `discover` to filter fetched roles.
- `scoring.json` — weights for the priority formula: `comp_fit, remote_eu_match, ai_proof, wlb, preference_match, company_preference`. Ships with equal weights as placeholders — tune once real enriched data exists.
- `settings.json` — `recruiter_nudge_days: 7`, `stale_days: 14`, `reapply_cooldown_months: 1`.
- `sources.json` (under `src/enrichment/`) — per data-source recipe: name, example/template URLs, `requires_login: boolean`, extraction instructions. Seed with placeholder entries for comp (levels.fyi/Glassdoor), WLB/tips (Glassdoor/Reddit/Blind) — you'll supply real example URLs to tighten these and stop Claude from over-browsing.

## Architecture

**CLI → DB → Daemon → Worker pool → Enrichment scripts → `claude` CLI / Playwright**

1. CLI commands (`cm companies add`, `cm roles add`, etc.) write directly to SQLite: create the entity row, insert one or more `jobs` rows, then check `.data/daemon.pid` — if the daemon isn't alive, spawn it detached (`{ detached: true, stdio: 'ignore' }`, `.unref()`), then return immediately. No waiting.
2. The daemon owns a **worker pool manager** with per-topic concurrency: `enrichment: 1` (Playwright/Chrome-bound, must serialize), `notification: 3`, `refresh: 1`, `discovery: 1`, `tips: 1`. Each worker polls for a claimable job with a single-statement claim (`UPDATE jobs SET status='running' WHERE id = (SELECT id FROM jobs WHERE topic=? AND status='pending' AND available_at<=? ORDER BY priority DESC, created_at ASC LIMIT 1) RETURNING *`), processes it, and marks `done`/`failed` (with backoff + retry) on completion — writing an `events` row either way.
3. **Enrichment handler**: looks up the relevant recipe in `sources.json`. If `requires_login`, fetches via `browser/profile.ts` (Playwright persistent context against `.data/browser-profile/`, headless); otherwise a plain HTTP fetch. Page content is piped into the matching `.sh` script, which calls `claude -p` with the content + recipe instructions and returns structured JSON (comp, equity, remote/EU for roles; IPO/AI-proof/WLB for companies). Structural fetch (name/description/title on `add`) follows the same shape but runs first/fast, separately from the "full enrichment" (comp/remote-EU/AI-proof/WLB) job that follows it automatically.
4. **Tips** are *not* part of automatic full enrichment — triggered on demand via `cm tips <role-id>`, which enqueues a `tips` job. Company-level findings are cached (checked via `tips.scope='company'` + `generated_at` freshness) and reused across roles at that company; role-specific findings layer on top per role.
5. **Notification jobs**: enqueued by other handlers (e.g. refresh detecting a closed role) with a message payload; the notification handler writes an `events` + `notifications` row and dispatches to the terminal digest and/or a macOS banner (`osascript`).
6. **`cm auth login-browser`**: launches Playwright non-headless against the persistent profile dir, waits for you to close the window, done. Re-run whenever a session expires.

## Feature-specific mechanics

- **Priority score**: `priority.ts` computes a weighted sum of normalized dimensions (comp fit vs. your target, remote+EU match, company AI-proof score, company WLB score, preference-profile match fraction, and the manual `company.preference_rating`), using `scoring.json` weights. Recomputed whenever a role's enrichment data, its company's enrichment/preference data, or the preference profile changes. Computed for every role regardless of status (cheap), but `cm roles list`'s default view filters to active statuses so terminal-state roles don't clutter sorting.
- **Duplicate detection**: on `cm roles add`, normalize company+title (case-insensitive/trim) and check against existing roles; on a match, hard-block and require `--force` to add anyway (deliberately strict — a bad add would cascade into enrichment jobs, notifications, etc. for a phantom role).
- **Reapply cooldown**: marking a role `denied` auto-sets `reapply_after = now + 1 month`, editable via `cm roles set-reapply`.
- **Pipeline digest (`cm status`)**: counts per status, roles with `status_changed_at` older than `settings.stale_days` (14, default) flagged as stalled, recruiter contacts overdue per `recruiter_nudge_days`, and roles with an upcoming/passed `reapply_after`. All computed at query time — no background "nudge" job needed yet, since there's no scheduler running unattended.
- **Interview notes**: `cm interview-note add <role-id> --stage "..." --notes "..."` — freeform, timestamped, feeds future Tips generation qualitatively (you read your own notes when re-researching similar roles).
- **Recruiter tracking**: intentionally minimal — `cm recruiters ping <role-id> --name --channel --link`, `cm recruiters respond <contact-id>`, `cm recruiters list --overdue`.
- **Refresh/discover**: both manual-only commands (`cm refresh`, `cm discover`) for now — `refresh` re-checks existing role URLs for closure (via the same fetch mechanism as enrichment) and enqueues notification jobs on closure; `discover` only scans career pages of companies you've already added, filters against `preferences.json`, and applies the same duplicate check before creating candidate roles. Periodic/launchd scheduling is a deliberately deferred later phase for both.

## Delivery process — commitable steps

Work proceeds one step at a time, each a separate commit. For each step:

1. Write that step's tests (first or alongside).
2. Implement until the tests are green.
3. Send the uncommitted diff to an independent review agent (the `code-review` skill/subagent — not a context-sharing fork, so the review isn't anchored to the same assumptions as the implementation).
4. Address every comment the reviewer raises — fix, or, if a comment is wrong or out of scope for this step, say why in the commit and move on rather than silently dropping it.
5. Re-run the tests, then commit.

A step should not start until the previous one's tests pass *and* has been through this review — later steps depend on earlier ones' schema/plumbing, so defects compound if they're not caught early.

**Test framework**: [Vitest](https://vitest.dev) — fast, TS-native, good `child_process` support for black-box CLI testing.

**Testing philosophy** (applies to every step below):
- **Primary: user-perspective tests.** Invoke the actual built `cm` binary via `child_process` against an isolated temp `.data` directory (env var override, e.g. `CM_DATA_DIR`), assert on stdout/exit code and resulting DB state. This is what "tests for that step" means by default — a scenario a user would actually run.
- **Secondary: unit tests** for pure-logic modules where a full CLI round-trip would be overkill or non-deterministic — scoring math (`priority.ts`), duplicate-match normalization, staleness/overdue date math, migration schema shape.
- **External dependencies** (`claude -p`, live websites, real browser login) are the one place black-box CLI tests become non-deterministic. Rule: fetch/network inputs are served from **local fixtures** (a tiny fixture HTTP server serving canned HTML, or a fixture profile directory with pre-seeded cookies) so tests are deterministic and CI-safe; only the `claude -p` extraction call itself is a live dependency in steps 7-10, and those steps should still assert on the *shape* of the result (fields present, sources array non-empty) rather than exact wording. A handful of steps also carry one **manual verification note** for things no automated test can cover (an actual human login flow) — these are called out explicitly, not silently skipped.

**Progress tracking**: the Status column below is the source of truth for what's done — keep it updated as part of each step's commit, don't rely on skimming `git log`. Status values: ✅ Done (committed, reviewed) · 🔲 Not started.

| # | Status | Step | Depends on | What "tests pass" means |
|---|---|---|---|---|
| 1 | ✅ Done | **Scaffolding** — package.json, tsconfig, directory layout, `cm` CLI entrypoint (commander) with `--help`/`--version` and stub subcommands | — | `cm --help` exits 0 and lists all top-level command groups |
| 2 | ✅ Done | **DB layer** — migrations, WAL-mode client, migration runner | 1 | Migrations apply cleanly to a fresh temp DB; re-running is idempotent; schema introspection confirms expected tables/columns |
| 3 | ✅ Done | **Companies CRUD** (no fetch/enrichment yet — raw fields only) — `add/list/show/set-preference/set-connections` | 2 | End-to-end: add a company, `list` shows it, `show` shows detail, `set-preference` updates and is reflected |
| 4 | ✅ Done | **Roles CRUD + status** — `add --company/list/show/set-status/set-reapply`, duplicate hard-block + `--force`, status_history | 3 | Add under a company; duplicate add blocked without `--force`, allowed with it; status change recorded with timestamp+context; `denied` auto-sets `reapply_after` +1 month; `set-reapply` overrides |
| 5 | ✅ Done | **Events + notifications + inbox** — events repo, notifications table, `cm events <id>`, `cm inbox` / `cm inbox ack`, terminal digest writer | 2 | Writing an event is retrievable via `cm events`; a notification appears in `cm inbox` until acknowledged |
| 6 | ✅ Done | **Job queue + daemon + worker pool** (no real handlers — a no-op "echo" job type proves the plumbing) — PID-file auto-start, per-topic concurrency, claim/complete/retry+backoff | 2 | Enqueue a test job → daemon auto-spawns → job goes pending→running→done; a forced-failing job retries with backoff then lands in `failed` after max attempts; concurrency=1 topic runs jobs strictly serially (assert via timestamps) |
| 7 | ✅ Done | **Structural fetch enrichment** — `.sh` script calling `claude -p` to extract company name/description, role title/description/company from fetched HTML; wired as an `enrichment` job handler auto-enqueued by `add`. Extended beyond the original scope: `roles add` no longer requires `--company` — omit it and the role is created immediately (company `NULL`/pending) and the structural-fetch job resolves/creates the company by reading the actual role page, not a URL guess (unreliable for ATS-hosted postings). Required making `roles.company_id` nullable (migration 0002) and, since SQLite has no ALTER COLUMN, a from-scratch rework of migration cross-process safety (file lock + stale-holder recovery) to do that without risking the FK-cascade-on-DROP data-loss trap. | 3,4,6 | Fixture HTML server + live `claude -p`: `cm companies add`/`cm roles add` end with fetched fields populated; a role added without `--company` gets a company auto-created *or* attached to an existing matching one (no duplicates), and that company itself gets a follow-up structural fetch. |
| 8 | ✅ Done | **Browser automation + full enrichment + priority scoring** (merged from the original separate steps 8/9 — WLB's only real source, Glassdoor, is login-gated, so building a throwaway non-login WLB pass first and redoing it against Glassdoor later was pure waste) — Playwright persistent-profile helper (`src/browser/profile.ts`, cross-process-locked via the same file-lock primitive migrations use), `cm auth login-browser`. Full enrichment auto-chains after structural fetch as three job kinds: `role-research` (comp/equity/remote-EU) and `company-research` (IPO status/AI-proofness) both use `claude -p` with **`--allowedTools WebSearch` explicitly granted** — confirmed empirically that without it, `claude -p` silently answers from trained knowledge with a fabricated source instead of actually searching, a real correctness trap, not a hypothetical one; `company-wlb` is architecturally different — Glassdoor is login-gated, so web search can't reach it at all, and it needs a real `urlTemplate` in `sources.json` to do anything (fetched via the Playwright profile, then extracted like structural fetch). Ships with `company_wlb.urlTemplate` unset, so it no-ops with a clear event until one is supplied, rather than attempting doomed browser automation — matches the original "you'll supply real example URLs" design intent. `priority.ts`: weighted-sum scoring (comp fit, remote/EU match, AI-proof, WLB, preference match, `company.preference_rating`) from `.data/config/scoring.json` (auto-seeded with equal-weight defaults on first read; `.data/config/preferences.json` likewise for the min-salary comp-fit term). | 7 | Automated: a persistent Playwright context against a test profile dir can navigate/read a local fixture page, and reusing a pre-seeded-cookie profile works headlessly without re-prompting (proven with a real persistent, non-session cookie — a session cookie is correctly discarded by the browser on close, confirmed by hand, not a bug). Live `claude -p` web search against a real company (Stripe) finds genuinely grounded data, not fabricated answers. `priority.ts` unit tests cover known-input→known-score cases including the `company.preference_rating` term. **Manual verification note**: an actual login (e.g. Glassdoor) via `cm auth login-browser`, confirming a subsequent headless fetch succeeds — no automated test can cover a real human login; you'll need to run this yourself and supply a real `company_wlb.urlTemplate` before WLB research does anything. |
| 9 | ✅ Done | **Tips** — `cm tips <role-id>` is deliberately synchronous (unlike `add`): enqueues a `tips`-topic job, ensures the daemon is running, then polls and blocks until it completes before printing — there's no benefit to a fire-and-forget UX for a command whose whole point is reading the output right away, and blocking still gets the job queue's retry/backoff for free. Company-level tips (culture, interview process, general sentiment) are cached (30-day freshness window) and reused across roles at that company; role-level tips layer on top per role, using the company tips as context. Both use `claude -p` with `--allowedTools WebSearch`, same as Step 8's research calls, with sources mandatory in the prompt (not just requested — an empty citation list gets its own logged event, `*.tips_no_sources_cited`, so a citation-free answer is visible, not silently accepted). | 8 | Repository-level tests cover the freshness-window cache logic directly (seeded rows, no live dependency). Live: two roles at the same company — the first produces non-empty `sources` in the DB (not just checking the word "Sources:" appears in output, which also prints for the empty case) for both company- and role-level tips; the second reuses the cached company-tips row (count stays 1) while still producing its own fresh role-tips row. Fast CLI tests cover the two error paths (unknown role, unresolved company) that exit before any live call. |
| 10 | 🔲 Not started | **Recruiter tracking + interview notes** — `ping/respond/list --overdue`, `interview-note add` | 5 | `ping` creates a contact; `list --overdue` respects `settings.recruiter_nudge_days` against a seeded past `contacted_at`; `respond` clears overdue status |
| 11 | 🔲 Not started | **Refresh + Discover** (manual-trigger commands) — closure detection + notification on close; career-page scan filtered by `preferences.json`, duplicate-checked | 6,7,8 | Fixture "closed" page → `refresh` produces a notification; fixture careers listing → `discover` creates only preference-matching, non-duplicate candidate roles |
| 12 | 🔲 Not started | **Pipeline digest** — `cm status`: counts per status, stale-role flagging (`settings.stale_days`), recruiter-overdue summary, reapply-date summary | 4,10,11 | Seed a temp DB with known-age roles/contacts, assert digest output categorizes each correctly |
| 13 | 🔲 Not started | **Polish** — `npm link`-able bin, `.gitignore` for `.data/`, README, error-handling pass | all | Global `cm` resolves post-link, `--help` works, no stray `.data/` artifacts tracked by git |

Each step's tests live alongside the code they cover (e.g. `src/db/*.test.ts`, `test/cli/companies.test.ts` for black-box CLI tests) rather than a single monolithic test file.

## Verification (whole-system, post-build)

Once all 13 steps are done, run the full manual smoke test end-to-end against real services:

1. `cm companies add <a real public company URL>` — daemon auto-starts, structural fetch completes, `cm companies show <id>` reflects fetched name/description, `cm events <id>` shows the audit trail.
2. `cm roles add <a real role URL>` — duplicate-check passes, full enrichment job runs automatically (comp/remote-EU/AI-proof/WLB populated in `show`), re-adding the same company+title is hard-blocked without `--force`.
3. `cm auth login-browser` against a real login-gated source (e.g. Glassdoor) — log in once, then trigger enrichment/tips depending on that source and confirm it succeeds headlessly without re-prompting.
4. `cm tips <role-id>` — output includes a `sources` list with real links; a second role at the same company reuses cached company-level findings (check `generated_at`/logs).
5. `cm roles set-status <id> denied` — `reapply_after` auto-populates +1 month, `role_status_history` records the transition.
6. `cm recruiters ping ...` then `cm status` after the nudge window — surfaces as overdue.
7. `cm roles list --sort=priority` — ordering reflects `scoring.json` weights; changing a company's `preference_rating` shifts its roles' scores after recompute.
