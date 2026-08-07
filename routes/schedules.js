const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isValidUrl, isNonEmptyString } = require("../utils/validate");
const { extractFromUrl } = require("../utils/extraction");
const { logAction } = require("../utils/audit");

const router = express.Router();

// POST /api/schedules  { spreadsheetId, url, frequencyHours }
// e.g. "check this price list URL every 24 hours and append any new rows to sheet 12"
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, url, frequencyHours } = req.body;
    if (!isNonEmptyString(url, 2000) || !isValidUrl(url)) {
      return res.status(400).json({ error: "a valid http(s) url is required" });
    }
    if (!Number.isInteger(spreadsheetId)) {
      return res.status(400).json({ error: "spreadsheetId is required" });
    }
    const freq = Number.isInteger(frequencyHours) && frequencyHours > 0 ? frequencyHours : 24;

    const sheetCheck = await db.execute({
      sql: "SELECT id FROM spreadsheets WHERE id = ? AND user_id = ?",
      args: [spreadsheetId, req.userId],
    });
    if (sheetCheck.rows.length === 0) {
      return res.status(404).json({ error: "spreadsheet not found or not owned by you" });
    }

    const result = await db.execute({
      sql: "INSERT INTO scheduled_extractions (user_id, spreadsheet_id, url, frequency_hours) VALUES (?, ?, ?, ?)",
      args: [req.userId, spreadsheetId, url, freq],
    });
    const id = Number(result.lastInsertRowid);

    await logAction({ userId: req.userId, action: "schedule.create", entityType: "schedule", entityId: id, details: { url, frequencyHours: freq }, ip: req.ip });

    res.status(201).json({ id, spreadsheetId, url, frequencyHours: freq });
  } catch (err) {
    next(err);
  }
});

// GET /api/schedules  -> list the user's scheduled extractions
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM scheduled_extractions WHERE user_id = ? ORDER BY created_at DESC",
      args: [req.userId],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/schedules/:id  { active: false }  -> pause/resume without deleting
router.put("/:id", requireAuth, async (req, res, next) => {
  try {
    const { active } = req.body;
    const result = await db.execute({
      sql: "UPDATE scheduled_extractions SET active = ? WHERE id = ? AND user_id = ?",
      args: [active ? 1 : 0, req.params.id, req.userId],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: "not found" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/schedules/:id
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: "DELETE FROM scheduled_extractions WHERE id = ? AND user_id = ?",
      args: [req.params.id, req.userId],
    });
    if (result.rowsAffected === 0) return res.status(404).json({ error: "not found" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
