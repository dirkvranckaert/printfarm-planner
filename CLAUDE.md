# PrintFarm Planner — Claude Code Context

## What this is

PrintFarm Planner is a browser-based 3D print farm scheduling tool, part of the Printseed product suite (three apps under APP3 BV). It lets Dirk plan print jobs across multiple 3D printers on a visual timeline, receive push notifications when jobs finish, and integrates with Bambu Lab printers via MQTT for real-time status.

## Who uses it

Dirk (primary), potentially other Printseed users. Accessed via browser (PWA-capable).

## Tech stack

- **Node 20+**, Express 5, better-sqlite3 (WAL mode), pm2 (fork, single instance)
- **Auth:** session cookie (`pf_session`) with 7-day TTL + shared JWT for cross-app SSO
- **MQTT:** connects to Bambu Lab printers for real-time status updates
- **Push:** `web-push` for browser notifications on job completion
- **Frontend:** vanilla HTML/JS/CSS, service worker, no build step
- **Tests:** Jest 29 + supertest

## Key modules

| File | Purpose |
|------|---------|
| `server.js` | Express app, all HTTP routes, session auth, CORS for cross-app |
| `db.js` | SQLite schema (printers, jobs, closures, sessions, settings) |
| `bambu.js` | MQTT client for Bambu Lab printer telemetry |
| `scheduling.js` | Job scheduling logic, conflict detection |
| `realign.js` | Timeline realignment when schedule changes |
| `pause.js` | Print pause/resume state tracking |
| `filament-match.js` | Match job filament needs against spool inventory |
| `parse3mf.js` | Extract metadata + thumbnails from .3mf print files |
| `printer-match.js` | Shared resolver: 3MF `printerName` → printer row (used by import auto-bind + client) |
| `shared-auth.js` | Validate cross-app JWT tokens (Printseed SSO pattern) |
| `push.js` | Web push subscription CRUD + notification dispatch |
| `awaiting-printer.js` | Pre-link job to idle/preparing printer ("Link when printer starts"): `STATUS`, `WINDOW_MS`, `isWithinStartWindow`, `assignPending` |

## Key decisions

- **Shared auth (JWT)** — all three Printseed apps share a JWT secret so users log in once and cross-navigate. This is the `shared-auth.js` module. It validates tokens from sibling apps via `Authorization` header or query param.
- **MQTT for Bambu** — real-time printer status without polling. The MQTT connection is managed in `bambu.js` with auto-reconnect.
- **Schema inline in db.js** — schema is defined directly in `db.js` using `CREATE IF NOT EXISTS` (not in a separate SQL file like Hebbes).
- **CORS configured per-sibling** — only allows origins from the other Printseed apps, configured via env vars.
- **Cool-down = per-job snapshot** — `jobs.cool_down_mins` copied from job's printer at creation (`resolveJobCoolDown` in `server.js`), NOT read live from `printers.cool_down_mins` at schedule time. So changing a printer's cooldown later does NOT shift the existing schedule. Attribution: gap AFTER job X uses X's own cooldown (finishing print). Manual override via job-edit modal. Fallback chain everywhere: `job.cool_down_mins ?? printer.cool_down_mins ?? 15`. Server scheduling authoritative; client visuals (buffer blocks, drag/slot previews, `detectConflicts`, `resolveConflictMoveAfter` in `public/app.js`) all mirror the same per-job value + fallback.

- **Warm-up = per-job snapshot too** — identical mechanism to cool-down. `jobs.warm_up_mins` snapshotted from job's printer at create (`resolveJobWarmUp` in `server.js`), editable via "Warm-up (min)" modal field. Fallback chain everywhere: `job.warm_up_mins ?? printer.warm_up_mins ?? 5`. Startup migration in `db.js`: guarded `ALTER TABLE jobs ADD COLUMN warm_up_mins` + self-healing backfill `UPDATE ... WHERE warm_up_mins IS NULL` OUTSIDE the guard (COALESCE from printer, else 5). So both cool_down AND warm_up are per-job snapshots — changing a printer/global warm-up does NOT reshuffle the existing schedule.

- **Job status model** — stored status values (exact): `Planned`, `Awaiting` (shown as "awaiting confirmation" in UI), `Awaiting Printer` (title-case, space — stored verbatim), `Printing`, `Post Printing`, `Done`, `Paused`. `Paused` and `Awaiting Printer` are **system-managed** — never a user-selectable status button. `Paused` set by pause pipeline (`pause.js`); `Awaiting Printer` set by link-when-printer-starts pipeline (`awaiting-printer.js`). Status order convention: context menu + change dialog both go planned → awaiting confirmation → printing → post printing → done; the Job Status Overview dialog additionally shows `Paused` directly after Printing, and `Awaiting Printer` between `Awaiting` and `Printing`. The "Job Status" menu badge = count of `Post Printing` + `Paused` (attention statuses); `Awaiting Printer` is NOT counted (badge unchanged). Badge count = pure fn `countAttentionJobs` in `public/statusCount.js`, shared by browser badge + Jest test. Status changes go through `PATCH /api/jobs/:id` (status is a whitelisted field).

- **Link when printer starts** — pre-link a job to an idle/preparing printer before it starts. Action in BOTH desktop context-menu and mobile bottom-sheet (shared `jobLinkMenuState` + `applyLinkAction` in `public/app.js`). `PATCH /api/jobs/:id` intercepts `status === 'Awaiting Printer'` → `assignPending` (`awaiting-printer.js`). Two guards: **one pending job per printer** (409 on conflict) and **start-time window** — start must be within 24h of now on either side, past or future (inclusive; `WINDOW_MS = 24h`); empty/queued start ineligible (400/404). When printer transitions to `Printing`/RUNNING, existing linked-job SSE transition auto-links the pending job → `Printing`, skipping out-of-window pending jobs. "Cancel auto-link" clears the link + resets to `Planned`.

- **Items tracking (per-job piece counts)** — jobs carry optional `items INTEGER` (nullable), `items_lost INTEGER NOT NULL DEFAULT 0`, `plate_name TEXT`. Guarded idempotent ALTERs in `db.js` (same style as `project_id`/`locked`).
  - `items` auto-derived from 3MF on import: `plate.objectCount` (= `plate.objects.length`, excl. wipe tower) via `parse3mf.js`. Manual set/edit in job dialog. "Herlaad items uit 3MF" button re-reads; multi-plate 3MF → user picks plate from list.
  - Projects aggregate (`projects.js` `countsByProject`): `itemsDone`/`itemsBusy`/`itemsTotal`/`itemsLost`. `doneAdj = max(0, itemsDone - itemsLost)`, `totalAdj = max(0, itemsTotal - itemsLost)` — `items_lost` subtracted from BOTH done and total. `itemsLost` summed ONLY from tracked jobs (`items != null`).
  - Auto-migration `itemsMigration.js`: marker-guarded `migration.items_backfill_v1`; backfills `items IS NULL AND printFile != ''`; single-plate 3MF → `objectCount`; multi-plate → unique ±1min plate-duration match else stays NULL (permanently ambiguous, manual reload). Per-job try/catch (bad file → skip, never throw).
  - Projecten LIST modal (`public/app.js` `projectCounterHtml`): line1 `jobs X/Y`, line2 `items A/B · N bezig` / `· N verlies`.

- **3MF import** (commits `c32afb3`, `b0b603e`, `e8810eb`) — import a Bambu 3MF as print jobs.
  - **Wire format:** endpoints take **raw `application/octet-stream` body, NOT multipart**. Cookie auth only (`POST /login` → `pf_session`, no API tokens).
    - `POST /api/parse-3mf` — raw bytes → `{plates, thumbnails, printerName, sliced}` (preview).
    - `POST /api/import-3mf-schedule` — raw bytes + `X-Schedule` header (URI-encoded JSON). `mode:"queue"` = queue-only: `queued=1, start='', end='', status='Planned'`, skips the time-slot branch. Response `201 {jobs, file, project_id}`. `first-available`/`manual` modes kept for backward-compat; web always sends `queue`.
  - **One job per plate** — every plate → separate job (auto-named, thumbnail carried, `items` = `plate.objectCount`).
  - **Auto-bind printer** — on null `printerId`, resolve from 3MF `printerName` via shared `printer-match.js`. Binds ONLY on a single unambiguous match; 0 or 2+ matches → stays null/unassigned. Explicit `printerId` always wins.
  - **Lane-lock** — a job WITH a `printerId` can only be dragged/scheduled onto that printer's lane (ALL jobs with a printer, not just 3MF-bound ones). Unassigned jobs free. Explicit "Move to another printer" still reassigns. Gate on `dataset.printer` **presence**, NOT `!printerId` (id `0` trap).
  - **Queue-item menu** — bound queue jobs show a linked-printer chip + right-click menu (bound jobs only): earliest-available (`findNextValidStart`), schedule-to-now, specific date-time. To-now / picked-time reuse `planReshove` + existing `confirmReshove` warning. Endpoint `POST /api/jobs/:id/schedule-from-queue`.
  - **`jobs.printerId` now NULLABLE** — guarded/idempotent table-rebuild migration in `db.js` (first boot; preserves rows + autoincrement). Queued jobs keep empty `start`/`end` — invariant honored across attach-3mf, conflict-detect, push query, awaiting-printer.

- **Delete file cleanup** (commit `e8810eb`) — deleting a job (queued or scheduled) unlinks its `printFile` (`<hex>.3mf`) + `thumbFile` (`<hex>.png`) in `data/uploads` (UPLOADS_DIR). Ref-counted via `cleanupOrphanUploads()` — files shared across plates/copies, unlink only when no other job references it. Applied to `DELETE /api/jobs/:id` + `DELETE /api/printers/:id` cascade. ENOENT-safe. `POST /api/import` restore path untouched.

## Coding conventions

- **Code, comments, commits, docs:** English
- **UI text:** English (this is a work/professional tool)
- **Tests:** run `npm test` before claiming done. All tests must pass.
- **No CSS framework** — custom CSS with variables. Do not install Tailwind/Bootstrap.
- **No native `confirm()`** — use custom modal dialogs

## Running locally

```bash
npm install
cp .env.example .env    # ADMIN_USER, ADMIN_PASS, JWT_SECRET, MQTT_HOST, etc.
npm start               # default port from .env
```

## Tests

```bash
npm test                 # jest
```

- **Determinism:** run `npx jest --runInBand` for reliable green. Parallel jest flakes ~20% on a couple server tests — SQLite / port worker contention.
- **Testing from a `.claude/worktrees/` checkout:** two traps. (1) jest config `testPathIgnorePatterns` includes `/.claude/` → worktree path contains `.claude/worktrees/` → **0 tests collected** (silent "No tests found"). Override: `jest --testPathIgnorePatterns=/node_modules/`. (2) worktree has no `node_modules` — symlink it: `ln -s ../../../node_modules node_modules`. Then `./node_modules/.bin/jest --runInBand --testPathIgnorePatterns=/node_modules/`.

## Deploy

Sole deploy path = `../infrastructure/apps/printfarm-planner/deploy.sh` (infra-repo wrapper → `apps/_template/deploy.sh` engine). Engine gives snapshot + atomic releases + auto-rollback + auth health-check expecting 401 on `/login`. `data/` symlink excluded from releases. Startup migrations in `db.js` run every restart (see Gotchas) — so the snapshot matters. No repo-root deploy script exists; never add one.

This deploy is **standing-authorised for the team** (Senne / release engineer) via `~/.claude/settings.json` `autoMode.allow` (authorised 2026-07-31, same as project-calculator / Receptiq web / ka-social-web). Runs without a per-deploy confirmation. Safety comes from the engine: auth health-check expecting 401 on `/login` + auto-rollback on failure. Precondition: `npm test` green.

**Deploy from a worktree** (leaves a busy main checkout untouched): the infra wrapper honors a `SOURCE_CHECKOUT` env override (line 6, defaults to the main checkout). So `git worktree add /tmp/x origin/main` then `SOURCE_CHECKOUT=/tmp/x ./apps/printfarm-planner/deploy.sh` releases from the worktree without touching the working tree.

- **Production port:** 3457
- **Domain:** `printfarm.app3.be` → `46.101.206.198` (APP3 proxy VPS)
  - ⚠️ Repo-name-shaped subdomains were never wired up. `planner.app3.be` and `printfarm-planner.app3.be` resolve to `185.103.156.20` (Combell parking) and return HTTP 404. Never smoke-check against them — a stale `planner.app3.be` line here already sent a release engineer chasing a non-existent proxy/DNS bug twice (2026-05-02, 2026-07-24).
  - Siblings: `filament-manager` → `filaments.app3.be`, `project-calculator` → `3dprojects.app3.be`.
- **PM2 name:** `printfarm-planner`
- **Server:** `app3-node-01` (142.93.105.91)

## Gotchas

- **pm2 cwd caching:** pm2 caches cwd at first start. Delete + restart if you change ecosystem.config.js.
- **Service worker:** `public/sw.js` shell assets (`/`, `index.html`, `style.css`, `statusCount.js`, `app.js`) are **network-first** since v8 (cache = offline fallback only). Current `CACHE_NAME`: `printfarm-v8`. Effect: future JS fixes reach browsers on next load WITHOUT a manual cache bump (previously cache-first, so every shell-asset change needed a `CACHE_NAME` bump in the same commit). Intended tradeoffs: no fetch timeout; a server 5xx surfaces instead of falling back to the cached shell. `skipWaiting()`, activate-time cache purge and `clients.claim()` still wired.
- **MQTT reconnect:** if the MQTT broker is unreachable, `bambu.js` retries silently. Check pm2 logs if printer status stops updating.
- **SQLite WAL mode:** the `data/` directory must be writable and on a local filesystem (not NFS).
- **Schema migrations at startup (`db.js`):** run on `require('./db')`, re-run every `pm2 restart`. Convention: guard each `ALTER TABLE ADD COLUMN` by a column-existence check, but keep any idempotent backfill `UPDATE ... WHERE col IS NULL` OUTSIDE the guard, so a crash between the ALTER and the UPDATE self-heals on next boot. Non-destructive migrations only — never touch `start` / `end`.
- **Startup migration must NOT block `app.listen` (CRITICAL — caused a prod outage, incident `dfb273b`→fixed `ac7ad25`):** NEVER run the items backfill (or any heavy DB scan) synchronously at module top-level / before `app.listen`. It shells out to `unzip` per 3MF and blocks the event loop → port never binds → deploy health-check gets HTTP 000 → auto-rollback. Correct pattern: backfill runs ONLY inside the `app.listen(...)` callback (`runItemsBackfill()`), via `backfillItemsAsync` which `await`s `setImmediate` after EVERY job (`YIELD_EVERY=1`). Port binds first, scan yields. Verify any future startup migration the same way: prod-mode boot must answer `GET /login`=200 within ~1-2s.
- **realign.js `remainingMins <= 0` guard:** guard `<= 0` (NOT `< 0`) before back-computing a linked printing job's block from live progress. Bambu emits `mc_remaining_time = 0` in the first frames of a print (heat/prep, before slicer ETA loads); a `0` would pin block end to `now` and start to `now - duration`, dumping the job into the past. On remaining<=0 → skip the realign tick, keep last-known-good end.
- **push/pull-to-now option direction:** "push back to now" (start later→now) shown ONLY for PAST jobs; "pull forward to now" (start earlier→now) shown ONLY for FUTURE jobs; exactly-now → both hidden. All 4 push/pull options hidden for anchored jobs (`Printing` / `Awaiting Printer` / `linked_printer_id != null` / `queued`). Server never 400s on wrong direction — just no-ops.
- **Day-view scale invariant:** every absolutely-positioned day-grid overlay MUST route px↔min through `minToPx()` / `pxToMin()` (`public/app.js`), never raw `*60` px math, or it drifts at scale≠1 (tall screens).
- **Day-view side-by-side overlap (`computeColumnLayout`):** overlapping jobs split into columns instead of stacking. `computeColumnLayout(intervals)` = interval-graph column packing → `Map<id,{col,nCols}>`. Overlap computed on the **buffer-inclusive** interval `[start - warmUp, end + coolDown]` (per-job values), so two jobs with disjoint print windows but a clashing cool-down∩warm-up still split. N overlapping → each `width = 100/nCols%`, `left = col*100/nCols%`; lone job (nCols 1) keeps full-column CSS width. Vertical placement unchanged (`minToPx`).
- **Drag snap is opt-in:** default drag drops the job at the free 15-min-grid time (`snap15`). Hold CTRL or Cmd for the old snap-to-avoid behaviour — `onDragMove` sets `wantSnap = ctrlKey || metaKey`, only then calls `snapAvoidingJobs`. Applies to both the move drag and the queue→schedule drop path.
- **Buffer blocks tinted with the job's colour** (was grey hatch): `hexRgba(p.color, 0.07 light / 0.22 dark)` fill + dashed left-border in the full colour, so a buffer visually belongs to its job. Job colour = its printer's colour, so same-printer jobs share a hue.
- **SSE background-refresh: preserve scroll + skip no-op re-render.** Upcoming/Week/Month cache `lastUpcomingHtml`/`lastWeekHtml`/`lastMonthHtml` and skip the `innerHTML` swap when the markup is byte-identical (guard ALSO checks the `.<view>` container is present so a view-switch still forces a rebuild). Each restores its scroll container's `scrollTop` around the swap; Day view uses `#day-scroll` (`prevScrollTop` captured right before the swap). GOTCHA: any newly-displayed field MUST be included in the cached markup string `h`, else a real data change is byte-identical to the cache and wrongly skipped.
- **Week/Month fill full height, equal printer rows** (fix was vertical, never a width cap): `.week-table tbody tr { height: calc(100% / var(--week-rows,1)) }` with `--week-rows` = printers.length passed inline from `renderWeek`; `.month-grid` uses `flex:1` + `grid-auto-rows:1fr`.
- **Prod uploads path + cleanup discipline:** prod uploads live at `/var/www/printfarm-planner/shared/data/uploads`; retained files are bare `<hex>.3mf` / `<hex>.png` only. Prod file cleanup must be a committed script — never ad-hoc `ssh rm` (ref-counting is app-side via `cleanupOrphanUploads()`; a manual `rm` can orphan or wrongly delete a shared file).

## What NOT to do

- Do not remove `shared-auth.js` — other Printseed apps depend on cross-app JWT validation
- Do not install CSS frameworks
- Do not use `confirm()` or `alert()`
- Do not commit `.env`, `data/`, or `logs/`
- Do not change the production port (3457) without updating the infrastructure repo's nginx.conf and deploy.sh

## Shared infrastructure

Deploy scripts, nginx configs, and runbooks live in `../infrastructure/`. That repo's `apps/printfarm-planner/deploy.sh` is a thin wrapper around `apps/_template/deploy.sh`.

## Architecture guide

The full house-style spec: `/Users/dirkvranckaert/Documents/personal-assistant/docs/app-architecture-guide.md`
