const express = require("express");
const { db } = require("../db");
const { extractFromUrl } = require("../utils/extraction");
const { logAction } = require("../utils/audit");

const router = express.Router();

/**
 * Free automated backup, no paid services:
 * 1. cron-job.org (free) hits this endpoint on a schedule (e.g. daily).
 * 2. It dumps all tables to JSON.
 * 3. It emails that JSON as an attachment via Brevo's free-tier HTTP API
 *    (same approach already used for Atma Raksha AI, since Render blocks SMTP ports).
 *
 * Protected by a shared secret (BACKUP_SECRET) rather than user JWT auth, since
 * cron-job.org calls this on a timer with no logged-in user involved.
 */
router.post("/backup", async (req, res, next) => {
  try {
    const providedSecret = req.headers["x-backup-secret"];
    if (!providedSecret || providedSecret !== process.env.BACKUP_SECRET) {
      return res.status(401).json({ error: "invalid or missing backup secret" });
    }
    if (!process.env.BACKUP_EMAIL || !process.env.BREVO_API_KEY) {
      return res.status(500).json({ error: "backup email not configured - set BACKUP_EMAIL and BREVO_API_KEY" });
    }

    const [users, spreadsheets, collaborators, auditLog] = await Promise.all([
      db.execute("SELECT id, email, created_at FROM users"), // password_hash intentionally excluded
      db.execute("SELECT * FROM spreadsheets"),
      db.execute("SELECT * FROM spreadsheet_collaborators"),
      db.execute("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 5000"),
    ]);

    const backup = {
      generatedAt: new Date().toISOString(),
      users: users.rows,
      spreadsheets: spreadsheets.rows,
      collaborators: collaborators.rows,
      auditLog: auditLog.rows,
    };

    const backupJson = JSON.stringify(backup, null, 2);
    const backupBase64 = Buffer.from(backupJson).toString("base64");
    const filename = `backup-${new Date().toISOString().slice(0, 10)}.json`;

    const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: process.env.BACKUP_EMAIL, name: "Data Operator Backups" },
        to: [{ email: process.env.BACKUP_EMAIL }],
        subject: `Data Operator backup - ${new Date().toISOString().slice(0, 10)}`,
        htmlContent: `<p>Automated backup attached.</p>
          <p>${spreadsheets.rows.length} spreadsheets, ${users.rows.length} users.</p>`,
        attachment: [{ content: backupBase64, name: filename }],
      }),
    });

    if (!brevoRes.ok) {
      const errText = await brevoRes.text();
      throw new Error(`Brevo email failed (${brevoRes.status}): ${errText.slice(0, 300)}`);
    }

    res.json({ success: true, recordCounts: { users: users.rows.length, spreadsheets: spreadsheets.rows.length } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/run-scheduled  header X-Backup-Secret: <BACKUP_SECRET>
// Triggered by a free cron-job.org job (e.g. hourly). Finds every active schedule that's
// due (now - last_run_at >= frequency_hours) and re-runs its URL extraction, appending any
// new rows to the target sheet. Reuses the same secret as backups - one shared cron caller.
router.post("/run-scheduled", async (req, res, next) => {
  try {
    const providedSecret = req.headers["x-backup-secret"];
    if (!providedSecret || providedSecret !== process.env.BACKUP_SECRET) {
      return res.status(401).json({ error: "invalid or missing secret" });
    }

    const schedules = await db.execute({
      sql: "SELECT * FROM scheduled_extractions WHERE active = 1",
      args: [],
    });

    const results = [];
    for (const schedule of schedules.rows) {
      const dueSince = schedule.last_run_at
        ? (Date.now() - new Date(schedule.last_run_at).getTime()) / 3600000
        : Infinity;
      if (dueSince < schedule.frequency_hours) continue; // not due yet

      try {
        const extracted = await extractFromUrl(schedule.url);
        const sheetRes = await db.execute({ sql: "SELECT * FROM spreadsheets WHERE id = ?", args: [schedule.spreadsheet_id] });
        if (sheetRes.rows.length === 0) continue;

        const sheet = sheetRes.rows[0];
        const existingRows = JSON.parse(sheet.rows_json);
        const combinedRows = [...existingRows, ...extracted.rows]; // simple append; de-dupe is a manual/AI-command step afterward

        await db.execute({
          sql: "UPDATE spreadsheets SET rows_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [JSON.stringify(combinedRows), schedule.spreadsheet_id],
        });
        await db.execute({
          sql: "UPDATE scheduled_extractions SET last_run_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [schedule.id],
        });
        await logAction({
          userId: schedule.user_id,
          action: "schedule.run",
          entityType: "spreadsheet",
          entityId: schedule.spreadsheet_id,
          details: { url: schedule.url, rowsAdded: extracted.rows.length },
        });

        results.push({ scheduleId: schedule.id, status: "success", rowsAdded: extracted.rows.length });
      } catch (err) {
        results.push({ scheduleId: schedule.id, status: "failed", error: err.message });
      }
    }

    res.json({ checked: schedules.rows.length, ran: results.length, results });
  } catch (err) {
    next(err);
  }
});
module.exports = router;
