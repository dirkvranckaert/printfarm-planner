# PrintFarm Planner

A browser-based print farm scheduling tool for 3D printers. Plan and track print jobs across multiple printers in day, week, month, and upcoming views. Includes live printer status via brand integrations (currently BambuLab cloud MQTT).

Built with Node.js + Express + SQLite. Protected by session-based cookie auth. Deployable on Railway (or any Node-capable host with persistent disk).

---

## Features

- Day / week / month / upcoming calendar views
- Multiple printers, each with a custom color and brand
- Print jobs with customer name, order number, filament colors, print file, status, and remarks
- Drag to move or resize jobs in day view
- Queue panel — park jobs with no date yet, schedule them later
- Closure periods (holidays, breaks) that block scheduling
- Configurable status colors, default view, and queue auto-expand on startup
- Dark / light / system theme (persisted per-browser via settings)
- Session-based login page (no browser credential dialog)
- Sign out link
- **Live printer status** via brand integrations — progress %, temperatures, remaining time
- **Multi-color / AMS info** — loaded filament slots shown in the status hover popup

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
├── bambu.js              ← BambuLab cloud MQTT client (low-level)
├── brands/
│   ├── index.js          ← Brand registry — connectAll, onUpdate, getAllStatuses
│   └── bambulab.js       ← BambuLab brand module + Express router
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

## BambuLab live status integration

PrintFarm Planner connects to BambuLab's cloud MQTT to show real-time printer status — progress, temperatures, remaining time, and AMS filament slots — directly in the UI. No LAN access or developer mode is required.

### Connecting your BambuLab account

1. Open the app → **Settings** (gear icon)
2. Under **BambuLab Connection**, enter your BambuLab email, password, and MQTT region (`us` for EU/US, `cn` for China)
3. Click **Connect** — if your account has 2-step verification enabled, a code will be sent to your email; enter it in the next step
4. Once connected, a green dot confirms the live link is active

Credentials are stored in the SQLite `settings` table (never in `.env`). You can disconnect at any time via Settings → Disconnect.

### Assigning a serial number to a printer

1. Open **Printers** → add or edit a printer
2. Select **BambuLab** as the brand
3. Enter the printer's serial number (found in BambuLab Studio or on the printer label)
4. Save — the printer will subscribe to live updates immediately

### What is shown

The status bar at the top of the UI shows a chip for every live-connected printer. Hover over a chip to see:

| Info | Source |
|------|--------|
| Stage (Printing / Paused / Finished / Error / Idle) | `gcode_state` |
| Progress % + progress bar | `mc_percent` |
| Remaining time | `mc_remaining_time` |
| Nozzle temp (current / target) | `nozzle_temper` / `nozzle_target_temper` |
| Bed temp (current / target) | `bed_temper` / `bed_target_temper` |
| AMS filament slots (color, material, K factor) | `ams.ams[].tray[]` |
| External spool | `vt_tray` |
| Active slot indicator (arrow below the loaded slot) | `tray_now` |

### Supported regions

BambuLab MQTT has two broker regions:

| Region value | Broker |
|---|---|
| `us` | `us.mqtt.bambulab.com:8883` (use for EU and US accounts) |
| `cn` | `cn.mqtt.bambulab.com:8883` (China accounts only) |

### Account requirements

- Must use a BambuLab account with email + password (Google/Apple login and accounts with hardware 2FA are not supported)
- One account can monitor multiple printers — all printers on the same account share the same MQTT connection

---

## Printer brand framework

Live status integrations are built around a brand registry in `brands/`. Each brand is a self-contained module. `server.js` never imports brand code directly — it only calls `brands.connectAll()`, `brands.onUpdate()`, etc.

### Adding a new brand integration

1. Create `brands/{slug}.js` (copy `brands/bambulab.js` as a starting point)
2. Register it in `brands/index.js`:
   ```js
   const myBrand = require('./mybrand');
   const registry = [bambulab, myBrand];
   ```
3. If your brand needs auth/config API endpoints, add them to its Express `router`
4. Add brand-specific printer fields to the DB via a migration in `db.js`
5. Show brand-specific form fields in the Printers modal in `index.html` (hidden by default, shown when the brand is selected)
6. Update `printerStatusKey()` in `public/app.js` to return the compound key for your brand

### Brand module contract

A brand module must export:

```js
module.exports = {
  id:   String,   // slug — matches printer.brand in DB, used in API path /api/brands/{id}/
  name: String,   // display name shown in the UI

  // Lifecycle (called by brands/index.js)
  connect(db):            Promise<void>,   // start connection on server boot
  disconnect():           void,            // tear down connection
  reinit(db):             Promise<void>,   // disconnect + reconnect (after config change)
  isConnected():          boolean,

  // Printer key — how to look up live status for a printer DB row
  getPrinterKey(printer): string | null,   // e.g. printer.bambu_serial; null if not configured

  // Subscribe a newly added/updated printer to live updates
  subscribeForPrinter(printer): void,

  // Status data (keyed by printerKey, not the compound "brand:key")
  getStatus(printerKey):  statusObj | null,
  getAllStatuses():        { [printerKey]: statusObj },

  // Register a callback fired on every status update
  onUpdate(cb: (printerKey: string, status: statusObj) => void): void,

  // Optional: Express Router mounted at /api/brands/{id}/
  router?: express.Router,
};
```

### Status object shape

All fields are optional except `updated_at`.

```js
{
  stage:         'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'IDLE',
  progress:      number,          // 0–100
  remaining:     number,          // minutes remaining
  nozzle_temp:   number,
  nozzle_target: number,
  bed_temp:      number,
  bed_target:    number,
  slots: [                        // multi-color / filament info (optional)
    {
      id:        string,          // e.g. 'A1', 'A2', 'B3', 'Ext'
      label:     string,          // material name or 'Empty'
      color:     string | null,   // CSS hex e.g. '#FF69B4', or null
      material:  string | null,   // e.g. 'PLA', 'PETG'
      remainPct: number | null,   // filament remaining 0–100
      k:         number | null,   // pressure advance / K factor
      active:    boolean,         // true = currently loaded
      empty:     boolean,
    }
  ],
  updated_at: string,             // ISO 8601 timestamp
}
```

### Frontend status keys

Status is keyed as `"{brand.id}:{printerKey}"` in the SSE stream and in-memory `printerStatus` map — e.g. `"bambulab:01P00A123456789"`. `printerStatusKey(printer)` in `public/app.js` computes this key; add a case there for each new brand:

```js
function printerStatusKey(printer) {
  if (printer.brand === 'bambulab' && printer.bambu_serial) return `bambulab:${printer.bambu_serial}`;
  // if (printer.brand === 'prusa' && printer.prusa_serial)   return `prusa:${printer.prusa_serial}`;
  return null;
}
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
| POST | `/api/printers` | Create printer — body: `{ name, color, brand, bambu_serial? }` |
| PUT | `/api/printers/:id` | Replace printer — body: `{ name, color, brand, bambu_serial? }` |
| DELETE | `/api/printers/:id` | Delete printer and all its jobs |

`brand` is a slug string. Known values: `bambulab`, `prusa`, `creality`, `klipper`, `octoprint`, `other`. `bambu_serial` is only relevant when `brand === 'bambulab'`.

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

Queued jobs have `queued = 1`; scheduled jobs have `queued = 0` with real datetime values.

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

### Live printer status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/printers/status/stream` | SSE stream — sends `data: { "brand:key": statusObj }` on each update; also sends a full snapshot on connect |

### Brand-specific endpoints

Each brand module mounts its own router at `/api/brands/{id}/`. Currently:

**BambuLab** — `/api/brands/bambulab/`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/brands/bambulab/config` | Returns `{ email, region, connected }` |
| POST | `/api/brands/bambulab/connect` | Login step 1 — body: `{ email, password, region }`. Returns `{ status: 'ok' }` or `{ status: 'verifyCode' }` |
| POST | `/api/brands/bambulab/verify` | Login step 2 — body: `{ code }`. Returns `{ status: 'ok' }` |
| DELETE | `/api/brands/bambulab/connect` | Disconnect — clears credentials and stops MQTT |

---

## Database schema

```sql
CREATE TABLE printers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  brand        TEXT NOT NULL DEFAULT 'other',
  bambu_serial TEXT
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
  durationMins INTEGER NOT NULL DEFAULT 0,
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

Schema is applied via `CREATE TABLE IF NOT EXISTS` in `db.js` on every startup. Missing columns (`brand`, `bambu_serial`, `queued`, `durationMins`) are added via `ALTER TABLE` migrations at startup.

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

No Bambu credentials go in `.env` — configure the BambuLab connection through the Settings UI after deployment.

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
- **Auth.** On login, the server generates a 32-byte random token, stores it in an in-memory `Set`, and sets an `HttpOnly` cookie (`pf_session`). Sessions are lost on server restart — users are redirected to login again.
- **Theme.** The `theme` setting is loaded at startup in `app.js` and applied as a `data-theme` attribute on `<html>`. `system` removes the attribute (letting the OS `prefers-color-scheme` media query take effect), `light`/`dark` set it explicitly.
- **Settings storage.** Values are `JSON.stringify`-ed on write and `JSON.parse`-d on read, so `value` can be a string, number, boolean, or object transparently.
- **Deleting a printer** cascades to its jobs server-side in `DELETE /api/printers/:id`.
- **PATCH vs PUT for jobs.** Drag-and-resize operations use `PATCH` (partial update). The job form uses `PUT` (full replace).
- **Brand modules** live in `brands/`. Each module has its own `_db` reference so it can read/write DB settings directly without going through `server.js`.
