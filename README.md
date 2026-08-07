# Data Operator — Setup Guide

Two parts: `backend/` (Node.js/Express, deploy to Render — same as Atma Raksha AI)
and `android/` (Kotlin skeleton to open in Android Studio).

## 1. Backend setup

1. Upload the `backend/` folder's files to a new GitHub repo (same manual method you used
   for Atma Raksha AI — create each file via GitHub's mobile web "Add file" button).
2. On Render: New → Web Service → connect the repo. Build command: `npm install`.
   Start command: `npm start`.
3. In Render's Environment tab, add these variables (copy from `.env.example`):
   - `JWT_SECRET` — any long random string
   - `TURSO_DB_URL` and `TURSO_DB_AUTH_TOKEN` — create a free database at turso.tech,
     same as Atma Raksha AI's backend
   - `GEMINI_API_KEY` — from Google AI Studio (free tier)
4. Once deployed, note your URL, e.g. `https://data-operator-backend.onrender.com`.
5. Test it's alive: open `https://your-url.onrender.com/health` in a browser — should
   return `{"status":"healthy",...}`.

### API endpoints
All routes below except signup/login need `Authorization: Bearer <token>`.

- `POST /api/auth/signup` / `POST /api/auth/login` → `{ email, password }`
- `POST /api/extract/text` → `{ text }`
- `POST /api/extract/description` → `{ description }`
- `POST /api/extract/image` → multipart form, field name `image` (jpeg/png/webp/heic, max 15MB)
- `POST /api/extract/pdf` → multipart form, field name `pdf` (max 15MB, multi-page supported)
- `POST /api/extract/url` → `{ url }` — **really fetches the page server-side** (via cheerio),
  not just an AI guess. Covers "url", "link", and "website" input in one endpoint.
- `POST /api/spreadsheets/build` → `{ instruction }` — **the AI-builds-from-instruction feature**
- `POST /api/spreadsheets` / `GET /api/spreadsheets` / `GET,PUT,DELETE /api/spreadsheets/:id`
- `POST /api/spreadsheets/templates/visitor-log` → creates a ready-made attendance/visitor
  sheet (Name, Date, Time, Purpose columns)
- `POST /api/spreadsheets/:id/quick-entry` → `{ name, extraFields? }` — **Quick Log feature.**
  Appends a row with a **server-generated** timestamp (not the phone's clock, so it can't be
  backdated by changing device time). This is for attendance registers, meeting sign-ins,
  visitor logs, shift start/end — anywhere you need "log this person, right now" instead of
  typing a date and time by hand.
- `POST /api/spreadsheets/:id/share` → `{ email, role: "editor"|"viewer" }` — owner only.
  **RBAC feature** - gives another registered user editor or view-only access to a sheet.
- `GET /api/spreadsheets/:id/audit-log` → owner only. Every create/update/delete/share/quick-entry
  on that sheet, who did it, when, from what IP.
- `POST /api/admin/backup` → header `X-Backup-Secret: <BACKUP_SECRET>`. **Free automated backup** -
  dumps all data to JSON and emails it via Brevo. Trigger it daily with a free cron-job.org job
  (same pattern as Atma Raksha AI's keep-alive) hitting this URL with that header.

### Operator features (manual + AI)
**Manual, instant, no AI call, run entirely on-device or as exact server logic:**
- **Undo / Redo** — up to 50 steps, covers row/column add-delete, find & replace, dedupe, AI commands
- **Find & Replace** — replace all occurrences across every column instantly
- **Filter** — show only rows where a column contains a value (separate from sort)
- **Duplicate detection & removal** — exact-match check on any column, one tap to dedupe
- **Freeze header row** — column names stay visible while scrolling through rows
- **Copy row** (`duplicateRow` in the ViewModel) — clone a row's data instead of retyping
- **Column data validation** (`setColumnValidation` in the ViewModel) — lock a column to
  number/email/date format or a fixed list of allowed values (e.g. "Paid"/"Unpaid"); rejects
  bad input on the spot instead of catching it later

**AI Command — `POST /api/spreadsheets/:id/ai-command`, `{ command: "..." }`:**
This is the feature that actually starts replacing manual operator work. Type a plain-language
instruction and the AI applies it directly to the real data:
- "Remove duplicate rows by Invoice Number" → exact deterministic dedupe, not an AI guess
- "Sort by Date, newest first" → exact deterministic sort
- "Standardize all phone numbers to +91 format" → AI directly rewrites the affected cells
- "Add a column called Status defaulting to Pending" → exact deterministic column add
Under the hood: Gemini first classifies the command into either a precise operation
(find/replace, dedupe, sort, filter, add/remove column — applied exactly in code, so the AI
never "guesses" on financial figures for a structural change) or, for open-ended cleanup, a
direct AI-applied transform of the affected cells. Every command is audit-logged with exactly
what was requested and what changed. Capped at 500 rows per command for now — larger sheets
should be filtered first.

### Latest additions: confidence, templates, workbooks, scheduling
- **Confidence scores** — every extraction (text/image/pdf/url/description) now returns a
  `confidence` array (0-100 per row, or `null`). Low scores flag exactly which rows a human
  should double-check instead of trusting everything blindly. Stored in the Android
  ViewModel as `rowConfidence` - rendering it visually (e.g. color-coding low-confidence
  cells) is still a UI task, not yet wired into the grid display.
- **Templates library** — `GET /api/templates` lists ready-made layouts (GST Invoice Log,
  Salary Register, Inventory Tracker, Rent Roll, Visitor Log, Expense Tracker).
  `POST /api/templates/:key/create` creates a sheet from one instantly, no AI call needed.
- **Multi-sheet workbooks** — `POST /api/workbooks` creates a workbook (like a spreadsheet
  file), `POST /api/workbooks/:id/sheets` adds tabs to it, `GET /api/workbooks/:id` lists
  all sheets inside. A sheet with no workbook still works exactly as before - this is
  additive, not a breaking change to existing single-sheet spreadsheets.
- **Scheduled recurring extraction** — `POST /api/schedules` attaches a URL to a sheet with
  a frequency (e.g. "check every 24 hours"). `POST /api/admin/run-scheduled` (same
  `X-Backup-Secret` header as backups) is what a free cron-job.org job hits on a timer -
  it finds anything due, re-extracts the URL, and appends new rows automatically.

**Honest note on Android UI for these three:** the ViewModel functions and API wiring are
complete and correct, but dedicated screens (a template picker, a workbook/tab switcher, a
schedule manager) haven't been built yet - same pattern as previous additions. These are UI
tasks on top of solid, working plumbing, not missing logic.

### Free hardening added (no paid services)
- **Audit log** — append-only trail of every meaningful action (login, create, update, delete,
  share, quick-entry), stored in Turso, viewable per-sheet by its owner.
- **RBAC** — owner / editor / viewer roles per spreadsheet via a `spreadsheet_collaborators`
  table. Owners can share with `POST /:id/share`; editors can edit, viewers can only read.
- **Automated backups** — `POST /api/admin/backup`, triggered on a schedule by a free
  cron-job.org job, emails a full JSON export via Brevo's free tier. Set it up once:
  cron-job.org → new cron job → URL `https://your-backend/api/admin/backup`, method POST,
  header `X-Backup-Secret: <your BACKUP_SECRET>`, schedule daily.
- **Dependency scanning** — `.github/dependabot.yml` is included; GitHub automatically opens
  pull requests when a dependency has a known vulnerability, free on any repo.

### What's still NOT free (see BANK_MNC_REQUIREMENTS.md)
Encryption-at-rest, penetration testing, SOC 2/ISO 27001, uptime SLAs, and legal agreements
all require paying a third party — no code change makes those free. Everything above is the
complete list of what's achievable without spending money.

### Production-grade hardening included
- Input validation on every route (length limits, URL format checks, empty-body rejection)
- Centralized error handler — consistent JSON error shape, no leaked stack traces
- Rate limiting: 300 req/15min general, 60 req/15min on AI-calling routes (since those cost
  real money per call — this is the #1 thing that protects you from a runaway bill)
- Request logging via morgan
- File type/size validation on all uploads (rejects wrong mime types before they reach Gemini)

## 2. Android setup

1. Open Android Studio → New Project → Empty Views Activity, package name `com.dataoperator`.
2. Replace the generated files with the ones in `android/app/src/main/...` (same manual
   file-by-file approach as before — copy contents in via GitHub mobile web or Android
   Studio's file editor).
3. In `RetrofitClient.kt`, replace `BASE_URL` with your real Render URL from step 1.4 above.
4. Sync Gradle (the `build.gradle.kts` here lists every dependency you need).
5. Set `SpreadsheetActivity` as the launcher activity (already done in the Manifest).

### What's wired up vs. what's a stub
**Working:** networking layer (Retrofit + JWT interceptor, same pattern as Atma Raksha AI),
secure token storage, the editable grid (add/edit/delete rows and cells), calling the
AI-build-from-instruction endpoint, save-to-backend.

**Not built yet — you'll want to add:**
- A login/signup screen (TokenManager and the API calls exist; there's no UI screen yet)
- Image picker UI for the "extract from image" flow (the ViewModel method exists, just
  needs a file picker wired to it)
- Column add/rename/delete buttons in the UI (ViewModel supports it, no buttons yet)
- A "My Spreadsheets" list screen using `listSpreadsheets()`
- CSV export

## 3. Suggested next session
Test the backend endpoints with a tool like Postman first (or even just `curl`) before
wiring up the Android UI — it's much faster to catch bugs in the API alone.
