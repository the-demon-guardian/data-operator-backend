const { createClient } = require("@libsql/client");
require("dotenv").config();

const db = createClient({
  url: process.env.TURSO_DB_URL,
  authToken: process.env.TURSO_DB_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // A workbook groups related sheets together (e.g. "Invoices" + "Payments" for one client),
  // the way a real spreadsheet file has multiple tabs.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS spreadsheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      workbook_id INTEGER,
      title TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (workbook_id) REFERENCES workbooks(id)
    )
  `);

  // Free RBAC: owner is implicit (spreadsheets.user_id). This table adds shared
  // access with a role, so an owner can invite others as "editor" or "viewer".
  await db.execute(`
    CREATE TABLE IF NOT EXISTS spreadsheet_collaborators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spreadsheet_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE (spreadsheet_id, user_id)
    )
  `);

  // Append-only audit trail: who did what, when. Never updated or deleted by the app -
  // that's what makes it meaningful as an audit record rather than just a log line.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Scheduled recurring extraction - e.g. "check this URL every day and add new rows
  // to this sheet". A free cron-job.org job hits /api/admin/run-scheduled on a timer,
  // which finds anything due and runs it.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scheduled_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      spreadsheet_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      frequency_hours INTEGER NOT NULL DEFAULT 24,
      last_run_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (spreadsheet_id) REFERENCES spreadsheets(id)
    )
  `);

  console.log("Database ready.");
}

module.exports = { db, initDb };
