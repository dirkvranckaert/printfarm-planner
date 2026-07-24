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
| `shared-auth.js` | Validate cross-app JWT tokens (Printseed SSO pattern) |
| `push.js` | Web push subscription CRUD + notification dispatch |

## Key decisions

- **Shared auth (JWT)** — all three Printseed apps share a JWT secret so users log in once and cross-navigate. This is the `shared-auth.js` module. It validates tokens from sibling apps via `Authorization` header or query param.
- **MQTT for Bambu** — real-time printer status without polling. The MQTT connection is managed in `bambu.js` with auto-reconnect.
- **Schema inline in db.js** — schema is defined directly in `db.js` using `CREATE IF NOT EXISTS` (not in a separate SQL file like Hebbes).
- **CORS configured per-sibling** — only allows origins from the other Printseed apps, configured via env vars.

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
npm test
```

## Deploy

Deployed via the shared infrastructure repo: `../infrastructure/apps/printfarm-planner/deploy.sh`

- **Production port:** 3457
- **Domain:** `printfarm.app3.be` → `46.101.206.198` (APP3 proxy VPS)
  - ⚠️ Repo-name-shaped subdomains were never wired up. `planner.app3.be` and `printfarm-planner.app3.be` resolve to `185.103.156.20` (Combell parking) and return HTTP 404. Never smoke-check against them — a stale `planner.app3.be` line here already sent a release engineer chasing a non-existent proxy/DNS bug twice (2026-05-02, 2026-07-24).
  - Siblings: `filament-manager` → `filaments.app3.be`, `project-calculator` → `3dprojects.app3.be`.
- **PM2 name:** `printfarm-planner`
- **Server:** `app3-node-01` (142.93.105.91)

## Gotchas

- **pm2 cwd caching:** pm2 caches cwd at first start. Delete + restart if you change ecosystem.config.js.
- **Service worker:** `public/sw.js` is cache-first over `SHELL_URLS`, which includes `/style.css`, and `index.html` loads it with no cache-busting query. So **any** change to a shell asset under `public/` must bump `CACHE_NAME` in the same commit (current value: `printfarm-v4`). Skip it and the first load after deploy serves the old asset — change only shows on a second reload, which reads as "the fix didn't work". `skipWaiting()`, the activate-time cache purge and `clients.claim()` are already wired, so the version bump alone is enough.
- **MQTT reconnect:** if the MQTT broker is unreachable, `bambu.js` retries silently. Check pm2 logs if printer status stops updating.
- **SQLite WAL mode:** the `data/` directory must be writable and on a local filesystem (not NFS).

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
