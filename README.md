# PrintFarm Planner

A browser-based print farm scheduling tool for BambuLab printers. Plan and track print jobs across multiple printers in day, week, month, and upcoming views.

Built with Node.js + Express + SQLite. Protected by session-based cookie auth. Deployable on Railway (or any Node-capable host with persistent disk).

---

## Features

- Day / week / month / upcoming calendar views
- Multiple printers, each with a custom color
- Print jobs with customer name, order number, filament colors, print file, status, and remarks
- Drag to move or resize jobs in day view
- Queue panel — park jobs with no date yet, schedule them later
- Closure periods (holidays, breaks) that block scheduling
- Configurable status colors, default view, and queue auto-expand on startup
- Dark / light / system theme (persisted per-browser via settings)
- Session-based login page (no browser credential dialog)
- Sign out link

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18 |
| Framework | Express 5 |
| Database | SQLite via `better-sqlite3` (file: `data/planner.db`) |
| Auth | Session cookie (`pf_session`), credentials in `.env` |
| Frontend | Vanilla JS / CSS / HTML (no build step) |

---

## Project structure

```
printfarm-planner/
├── server.js             ← Express app: static serving, session auth, REST API
├── db.js                 ← SQLite setup and schema initialisation
├── ecosystem.config.js   ← PM2 process config
├── package.json
├── .env                  ← ADMIN_USER / ADMIN_PASS  (never commit — see .env.example)
├── .env.example          ← Template showing required variables
├── .gitignore
├── data/
│   └── planner.db        ← SQLite file (auto-created on first run, never commit)
└── public/
    ├── index.html
    ├── login.html        ← Login page (served unauthenticated)
    ├── app.js            ← All frontend logic; uses fetch() to call the REST API
    ├── style.css
    └── favicon.svg
```

---

## Local setup

**Requirements:** Node.js >= 18, npm

```sh
cd printfarm-planner
npm install
```

Copy `.env.example` to `.env` and fill in your credentials (`.env` is gitignored):

```sh
cp .env.example .env
```

```
ADMIN_USER=admin
ADMIN_PASS=yourpassword
PORT=3000
```

Start the server:

```sh
npm start
# or: node server.js
```

Open http://localhost:3000 — you will be redirected to the login page.

The SQLite database is created automatically at `data/planner.db` on first run. To start fresh, delete that file.

---

## Running in the background with PM2

[PM2](https://pm2.keymetrics.io/) keeps the server running in the background, restarts it on crashes, and can register it as a system service so it survives reboots.

### Install

```sh
npm install -g pm2
```

On macOS with a Homebrew Node installation, the `pm2` binary may not be on your PATH. If you get `command not found: pm2`, symlink it manually:

```sh
ln -sf "$(which node | xargs dirname)/pm2" /usr/local/bin/pm2
```

### Start

```sh
# From the printfarm-planner directory:
pm2 start ecosystem.config.js
pm2 save   # persist the process list so it survives reboots
```

### Auto-start on login — macOS (launchd)

```sh
pm2 startup
```

Copy-paste the `sudo env ...` command it prints, then run it. PM2 will now start automatically when you log in.

### Auto-start on boot — Linux / VPS (systemd)

```sh
pm2 startup systemd
# copy-paste the printed sudo command, then:
pm2 save
```

### Common commands

```sh
pm2 status                 # list all managed processes
pm2 logs printfarm         # tail live logs
pm2 restart printfarm      # restart after a code update
pm2 stop printfarm         # stop without removing from list
pm2 delete printfarm       # remove from list entirely
```

### Deploying an update

```sh
git pull
npm install --omit=dev
pm2 restart printfarm
```

---

## REST API

All endpoints (except `GET /login`, `POST /login`, `GET /logout`, and `GET /favicon.svg`) require a valid session cookie. Payloads and responses are JSON.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/login` | Serve the login page |
| POST | `/login` | Authenticate — body: `{ username, password }` — sets `pf_session` cookie on success |
| GET | `/logout` | Clear session cookie and redirect to `/login` |

### Printers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/printers` | List all printers |
| POST | `/api/printers` | Create printer — body: `{ name, color }` |
| PUT | `/api/printers/:id` | Replace printer — body: `{ name, color }` |
| DELETE | `/api/printers/:id` | Delete printer and all its jobs |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs` | List all jobs |
| GET | `/api/jobs/:id` | Get single job |
| POST | `/api/jobs` | Create job — body: see schema below |
| PUT | `/api/jobs/:id` | Replace job (full update) |
| PATCH | `/api/jobs/:id` | Partial update (used for drag/resize) |
| DELETE | `/api/jobs/:id` | Delete job |

Job body fields: `printerId` (int), `name`, `customerName`, `orderNr`, `start` (datetime-local string), `end` (datetime-local string), `queued` (bool), `status` (`Planned` / `Printing` / `Post Printing` / `Done`), `colors`, `printFile`, `remarks`

Queued jobs have `queued = 1`, `start` and `end` store the expected duration as a duration string; scheduled jobs have `queued = 0` with real datetime values.

### Closures

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/closures` | List all closures |
| POST | `/api/closures` | Create closure — body: `{ startDate, endDate, label }` |
| PUT | `/api/closures/:id` | Replace closure |
| DELETE | `/api/closures/:id` | Delete closure |

Dates are `YYYY-MM-DD` strings. `endDate` is inclusive.

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/:key` | Get setting — returns `{ key, value }` or 404 |
| PUT | `/api/settings/:key` | Upsert setting — body: `{ value }` |

Known keys:

| Key | Type | Description |
|-----|------|-------------|
| `defaultView` | string | `day` / `week` / `month` / `upcoming` |
| `statusColors` | object | `{ Planned, Printing, "Post Printing", Done }` — hex strings |
| `theme` | string | `system` / `light` / `dark` |
| `queueAutoExpand` | boolean | Expand queue panel on startup if not empty |

Values are JSON-serialised in the database, so `value` can be any JSON type.

---

## Database schema

```sql
CREATE TABLE printers (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  printerId    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  customerName TEXT,
  orderNr      TEXT,
  start        TEXT NOT NULL,
  end          TEXT NOT NULL,
  queued       INTEGER NOT NULL DEFAULT 0,
  status       TEXT DEFAULT 'Planned',
  colors       TEXT,
  printFile    TEXT,
  remarks      TEXT
);

CREATE TABLE closures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  startDate TEXT NOT NULL,
  endDate   TEXT NOT NULL,
  label     TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

Schema is applied via `CREATE TABLE IF NOT EXISTS` in `db.js` on every startup — no migration tooling needed at this stage.

---

## Deployment on Railway

Railway is the recommended host: it supports persistent volumes (needed for the SQLite file) and has a free tier.

1. Push this directory to a GitHub repo (the parent monorepo is fine).
2. Create a new Railway project and link the repo. Set the root directory to `printfarm-planner/` if deploying from the monorepo.
3. Add a persistent volume and mount it at `/app/data`.
4. Set environment variables in the Railway dashboard:
   - `ADMIN_USER` — login username
   - `ADMIN_PASS` — login password
   - `PORT` is set automatically by Railway; `server.js` reads it via `process.env.PORT || 3000`
5. Deploy. Railway will run `npm start` → `node server.js`.

### Alternative hosts

| Host | Notes |
|------|-------|
| **Render** | Free tier does not support persistent disks — swap SQLite for their free Postgres add-on (driver: `pg`). Paid tier works fine with a disk. |
| **Fly.io** | Persistent volumes work. Deploy with `flyctl`. |
| **DigitalOcean VPS** | Most control. Use nginx as a reverse proxy, PM2 as process manager, Let's Encrypt for HTTPS. SQLite just works as a file. |

---

## Development notes

- **No build step.** Edit files in `public/` and reload the browser.
- **Frontend ↔ API contract.** All data access in `app.js` goes through the `api(method, path, body)` helper at the top of the file.
- **Auth.** On login, the server generates a 32-byte random token, stores it in an in-memory `Set`, and sets an `HttpOnly` cookie (`pf_session`). Sessions are lost on server restart — users are redirected to login again. The login page (`login.html`) is served without authentication and applies dark mode via `@media (prefers-color-scheme: dark)` only (it cannot call the API to load the saved theme preference).
- **Theme.** The `theme` setting is loaded at startup in `app.js` and applied as a `data-theme` attribute on `<html>`. `system` removes the attribute (letting the OS `prefers-color-scheme` media query take effect), `light`/`dark` set it explicitly.
- **Settings storage.** Values are `JSON.stringify`-ed on write and `JSON.parse`-d on read in `server.js`, so the `value` field can be a string, number, boolean, or object transparently.
- **Deleting a printer** cascades to its jobs server-side in `DELETE /api/printers/:id`.
- **PATCH vs PUT for jobs.** Drag-and-resize operations use `PATCH` (partial update). The job form uses `PUT` (full replace).
