# PrintFarm Planner

A browser-based print farm scheduling tool for 3D printers. Plan and track print jobs across multiple printers in day, week, month, and upcoming views. Includes live printer status via brand integrations (currently BambuLab cloud MQTT).

Built with Node.js + Express + SQLite. Protected by session-based cookie auth. Deployable on Railway (or any Node-capable host with persistent disk).

---

## Features

- Day / week / month / upcoming calendar views, plus a Today summary panel
- Multiple printers, each with a custom color and brand
- Print jobs with customer name, order number, filament colors, print file, status, and remarks
- **Drag to move or resize jobs in day view** — including across printer columns; buffer blocks (warm-up / cool-down) follow visually during drag; snaps to adjacent job boundaries to prevent overlap
- **Favourite printers** — mark printers as favourites; only they are shown in day view (all printers still appear in week/month/upcoming). A ⚙ button in the day view header links to printer settings.
- Queue panel — park jobs with no date yet, schedule them later
- Closure periods (holidays, breaks) that block scheduling
- Configurable status colors, default view, queue auto-expand, and topbar display mode on startup
- Dark / light / system theme (persisted per-browser via settings)
- Session-based login page (no browser credential dialog); sessions survive server restarts
- Sign out link
- **Live printer status** via brand integrations — progress %, temperatures, remaining time; auto-refreshes on tab focus and reconnects the SSE stream after the browser suspends it in the background
- **Multi-color / AMS info** — loaded filament slots shown in the status hover popup; supports single-AMS (P1S) and multi-AMS (H2C) setups
- **Per-printer buffer times** — configurable warm-up and cool-down periods shown as cross-hatched blocks in day view; included in conflict detection and drag overlap prevention
- **Connected Accounts** — BambuLab account linked/unlinked directly from the Printers modal; account status shown in the printer list and edit dialog
- **Browser push notifications** — opt-in push alerts for printer started, printer finished (with job/customer/order details), and upcoming scheduled jobs; per-type on/off toggles in Settings

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
├── push.js               ← Web Push module: VAPID key management, send to subscribers
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
    ├── sw.js             ← Service worker: handles Web Push events, shows notifications
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
TOPBAR_PRINTER_LIMIT=3
BAMBU_AMS_DEBUG=false
BAMBU_AMS_DEBUG_SERIAL=   # optional: limit AMS debug logs to one printer serial
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

1. Open the app → **⋮ menu** → **Printers**
2. At the bottom of the panel, under **Connected Accounts**, click **+ Connect BambuLab Account**
3. Enter your BambuLab email, password, and MQTT region (`us` for EU/US, `cn` for China), then click **Connect**
4. If your account has 2-step verification, a code is sent to your email — enter it in the next step
5. Once connected, the account is shown in the Connected Accounts list with a disconnect button

Credentials are stored in the SQLite `settings` table (never in `.env`). You can disconnect at any time from the Connected Accounts panel.

### Assigning a serial number to a printer

1. Open **Printers** → add or edit a printer (opens a dialog)
2. Select **BambuLab** as the brand
3. Enter the printer's serial number (found in BambuLab Studio or on the printer label)
4. The dialog shows the current BambuLab account connection status next to the serial field
5. Save — the printer subscribes to live updates immediately

### Account status indicators

- A 🌐 icon appears next to printers in the list when a BambuLab account is connected and the printer has a serial number configured — hover for the account email
- In the printer edit dialog, a line below the serial field confirms whether the account is linked

### What is shown

The status bar at the top of the UI shows chips for a curated subset of connected printers (pinned or currently active, depending on the topbar display mode in Settings). A permanent 🖨 button opens a full-status panel showing all connected printers at once — 3–4 cards per row on wide screens. Hover over a chip to see:

| Info | Source |
|------|--------|
| Stage (Printing / Paused / Finished / Error / Idle) | `gcode_state` |
| Progress % + progress bar | `mc_percent` |
| Remaining time | `mc_remaining_time` |
| Nozzle temp (current / target) | `nozzle_temper` / `nozzle_target_temper` |
| Bed temp (current / target) | `bed_temper` / `bed_target_temper` |
| AMS filament slots (color, material, K factor) | `ams.ams[].tray[]` |
| External spool | `vt_tray` |
| Active slot indicator (arrow below the loaded slot) | `ams.tray_now` |

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

## Live job realignment & pause drift

When a job is linked to a physical printer (via `linked_printer_id`), the server continuously rewrites the job's `start` / `end` timestamps so the day-view bar always reflects the real state of the print. This runs entirely server-side — the client only re-renders when an SSE event fires.

### Live realign (RUNNING ticks)

- Every time a linked printer reports its `mc_remaining_time` while `gcode_state == 'RUNNING'`, `realign.realignLinkedJob` shifts the currently-printing job so its `end` matches `now + remaining_mins`. The block's **duration** is kept constant — start and end move together, the block slides without resizing.
- Throttled to one realign per linked printer per 60s (see `REALIGN_MIN_INTERVAL_MS` in `server.js`) to avoid thrashing on Bambu's ~2s MQTT cadence.
- If the new predicted end is **later** than the stored end (>2 min threshold), downstream Planned/Awaiting jobs on the same printer cascade backward via `scheduling.pushBackChain`, honoring warm/cool buffers, silent hours and closures.
- If the new predicted end is **earlier**, only the current job is pulled back — downstream jobs stay put, creating a "free gap" the user can fill manually. Pull-forward never cascades.

### Pause drift (PAUSE ticks)

Bambu freezes `mc_remaining_time` while the printer is paused, so the live-realign pipeline is gated off during PAUSE (it would drift `predicted_end` later every tick, then snap back on resume). Instead:

1. **On `RUNNING → PAUSE`** (`pause.beginPause`): the server snapshots `paused_at = now` and `paused_remaining_ms = max(0, job.end - now)` onto the job row and flips `status = 'Paused'`. `start` / `end` are not touched on the transition itself. The row status `'Paused'` is **system-only** — it is not exposed in any user-facing status picker; only the pause/resume pipeline writes it.
2. **Every 60s while paused** (`pause.pauseTick`, piggy-backed on the upcoming-notifications interval): for every paused job, the server rewrites `end = now + paused_remaining_ms` and shifts `start` to preserve the original duration. The day-view bar drifts forward with the now-line. Downstream Planned/Awaiting jobs cascade backward via `scheduling.pushBackChain`, same as the RUNNING realign.
3. **On `PAUSE → RUNNING`** (`pause.endPause`): the server clears `paused_at` and `paused_remaining_ms`, flips `status = 'Printing'`, and the existing snap-start realign re-snaps the block against the real reported `remaining`.

### Edge cases

- **Multi-pause** (pause → resume → pause): each fresh pause recomputes `paused_remaining_ms` from the freshly-realigned `end` written by the last RUNNING tick (or pauseTick).
- **Manual status change out of Paused** (Done / Cancelled / Planned via the edit dialog or status picker): the PUT/PATCH job routes call `pause.clearPauseFields` so the row does not carry a stale `paused_at` forever.
- **Server restart while paused**: because `paused_at` and `paused_remaining_ms` are persisted in SQLite, the first pauseTick after restart recomputes `end = now + paused_remaining_ms` and cascades downstream. The bar may jump forward by however long the server was down — that is the correct behavior.

### SSE stage transitions

Bambu often sends partial MQTT frames (temps / remaining without `gcode_state`), which `bambu.js` merges onto the previous status via a spread. The client-side diff would therefore miss any stage transition masked by a partial frame. To fix this, the server emits an explicit `{ stageChanged, from, to }` SSE event on every real transition (see `server.js` onUpdate handler); the client always re-renders the calendar on this event in addition to its own stage-present fallback.

---

## Push notifications

PrintFarm Planner can send browser push notifications for key events. Notifications work even when the tab is not focused, and on mobile when the browser is in the background.

### Setup

1. Open **Settings** → **Push Notifications**
2. Click **Enable Push Notifications** — the browser will prompt for permission
3. Once subscribed, a green "Enabled" indicator appears and three per-type toggles are shown
4. Click **Disable** at any time to unsubscribe

Subscriptions are stored server-side (`push_subscriptions` table) so they survive page reloads. If the browser subscription expires or is revoked, the server removes the stale entry automatically.

### Notification types

| Type | Trigger | Message |
|------|---------|---------|
| **Printer finished** | Bambu stage → FINISH or IDLE after RUNNING | With linked job: `Printer P1S has done printing order #42: 'Keychains' (Dirk)` — order/customer included when available. Without linked job: uses Bambu's current file name, or a generic fallback. |
| **Printer started** | Bambu stage → RUNNING | `Printer P1S has started printing` |
| **Upcoming job** | Planned job with start within 5 min | `It's about time to start printing 'Keychains' on P1S` — with order number: `It's time to start printing order #42 'Keychains' on P1S`. Sent once per job (`start_push_sent` flag). |

Each type can be individually enabled or disabled from Settings. All three are enabled by default once subscribed.

### Technical notes

- Uses the **Web Push API** with VAPID authentication (`web-push` npm package)
- VAPID keys are auto-generated on first server startup and stored in the `settings` table
- The service worker (`public/sw.js`) handles incoming push events and notification clicks
- Clicking a notification focuses the existing app tab, or opens a new one if none is open

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
| POST | `/api/printers` | Create printer — body: see fields below |
| PUT | `/api/printers/:id` | Replace printer — body: see fields below |
| DELETE | `/api/printers/:id` | Delete printer and all its jobs |

Printer body fields: `name`, `color` (hex), `brand`, `bambu_serial?`, `pinned?` (0/1), `warm_up_mins?`, `cool_down_mins?`, `favourite?` (0/1).

`brand` is a slug string. Known values: `bambulab`, `prusa`, `creality`, `klipper`, `octoprint`, `other`. `bambu_serial` is only relevant when `brand === 'bambulab'`.

`favourite = 1` causes the printer to appear in the day view. If no printers are marked as favourite, all printers are shown.
`pinned = 1` makes the printer appear in the topbar status chips (subject to `TOPBAR_PRINTER_LIMIT`).

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
| `topbarMode` | string | `pinned` (show ⭐ pinned printers) / `active` (show only printing printers) |
| `push.notify.done` | boolean | Send push when a printer finishes (default: `true`) |
| `push.notify.started` | boolean | Send push when a printer starts (default: `true`) |
| `push.notify.upcoming` | boolean | Send push for Planned jobs starting within 5 min (default: `true`) |
| `vapid.publicKey` | string | Auto-generated VAPID public key (managed by server, do not edit) |
| `vapid.privateKey` | string | Auto-generated VAPID private key (managed by server, do not edit) |

Values are JSON-serialised in the database, so `value` can be any JSON type.

### Live printer status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/printers/status/stream` | SSE stream — sends `data: { "brand:key": statusObj }` on each update; also sends a full snapshot on connect |

### Push notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/push/public-key` | Returns `{ publicKey }` — the VAPID public key needed to subscribe |
| POST | `/api/push/subscribe` | Save a push subscription — body: Web Push subscription object (`endpoint`, `keys`) |
| DELETE | `/api/push/unsubscribe` | Remove a push subscription — body: same subscription object |

Subscriptions are stored in the `push_subscriptions` table. Expired subscriptions (410/404 from the push service) are removed automatically. The server sends pushes for three event types — see Settings keys `push.notify.*` above to enable/disable each type.

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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL,
  brand          TEXT NOT NULL DEFAULT 'other',
  bambu_serial   TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,   -- 1 = show in topbar chips
  warm_up_mins   INTEGER NOT NULL DEFAULT 5,
  cool_down_mins INTEGER NOT NULL DEFAULT 15,
  favourite      INTEGER NOT NULL DEFAULT 1    -- 1 = show in day view
);

CREATE TABLE jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  printerId         INTEGER NOT NULL,
  name              TEXT NOT NULL,
  customerName      TEXT,
  orderNr           TEXT,
  start             TEXT NOT NULL,
  end               TEXT NOT NULL,
  queued            INTEGER NOT NULL DEFAULT 0,
  durationMins      INTEGER NOT NULL DEFAULT 0,
  status            TEXT DEFAULT 'Planned',
  colors            TEXT,
  printFile         TEXT,
  remarks           TEXT,
  linked_printer_id INTEGER,  -- set when job is manually linked to a live printer for auto-status updates
  start_push_sent   INTEGER NOT NULL DEFAULT 0  -- 1 once the "upcoming" push has been sent for this job
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

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription TEXT NOT NULL,  -- JSON Web Push subscription object (endpoint + keys)
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
```

Schema is applied via `CREATE TABLE IF NOT EXISTS` in `db.js` on every startup. Missing columns are added via `ALTER TABLE` migrations at startup.

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
   - `TOPBAR_PRINTER_LIMIT` — max printer chips shown in the topbar before collapsing into "+N more" (default: `3`)
   - `BAMBU_AMS_DEBUG` — set to `true` to log raw AMS MQTT payloads and parsed slot results (default: `false`)
   - `BAMBU_AMS_DEBUG_SERIAL` — optional: limit AMS debug logs to a single printer serial
5. Deploy. Railway will run `npm start` → `node server.js`.

No Bambu credentials go in `.env` — configure the BambuLab connection through the Settings UI after deployment.

### Alternative hosts

| Host | Notes |
|------|-------|
| **Render** | Free tier does not support persistent disks — swap SQLite for their free Postgres add-on (driver: `pg`). Paid tier works fine with a disk. |
| **Fly.io** | Persistent volumes work. Deploy with `flyctl`. |
| **DigitalOcean VPS** | Most control. Use nginx as a reverse proxy, PM2 as process manager, Let's Encrypt for HTTPS. SQLite just works as a file. |

---

## Testing

The project ships with a Jest test suite covering core DB logic and utility functions.

```sh
npm test
```

Test files live in `tests/`:

| File | What it covers |
|------|---------------|
| `tests/server.test.js` | Printer CRUD, job CRUD, cascading deletes, session validity logic, push notification message formats, push DB schema — all against in-memory SQLite |
| `tests/utils.test.js` | `snap15`, `toDatetimeLocal`, interval overlap detection, `snapAvoidingJobs` logic |

Tests are run automatically by Jest; no server process is needed. Add new tests alongside any non-trivial logic change.

---

## Day view — drag behaviour

| Action | How |
|--------|-----|
| Move a job | Drag anywhere on the job block |
| Resize a job | Drag the resize handle at the bottom edge |
| Move to a different printer | Drag the job sideways into another printer column |
| Create a new job | Click-and-drag on empty space in a column |
| Schedule a queued job | Drag from the queue panel onto a column |

**Snapping:** All drag operations snap to 15-minute boundaries. When a job is dragged close to another job's occupied zone (job time ± buffer), it snaps to the boundary of that zone instead, preventing overlap.

**Buffers during drag:** Warm-up and cool-down buffer blocks move with the job in real time.

---

## Development notes

- **No build step.** Edit files in `public/` and reload the browser.
- **Frontend ↔ API contract.** All data access in `app.js` goes through the `api(method, path, body)` helper at the top of the file.
- **Auth.** On login, the server generates a 32-byte random token, stores it in the SQLite `sessions` table (TTL: 7 days), and sets an `HttpOnly` cookie (`pf_session`). Sessions survive server restarts.
- **Theme.** The `theme` setting is loaded at startup in `app.js` and applied as a `data-theme` attribute on `<html>`. `system` removes the attribute (letting the OS `prefers-color-scheme` media query take effect), `light`/`dark` set it explicitly.
- **Settings storage.** Values are `JSON.stringify`-ed on write and `JSON.parse`-d on read, so `value` can be a string, number, boolean, or object transparently.
- **Deleting a printer** cascades to its jobs server-side in `DELETE /api/printers/:id`.
- **PATCH vs PUT for jobs.** Drag-and-resize operations use `PATCH` (partial update). The job form uses `PUT` (full replace).
- **Brand modules** live in `brands/`. Each module has its own `_db` reference so it can read/write DB settings directly without going through `server.js`.
