const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isNonEmptyString } = require("../utils/validate");
const { logAction } = require("../utils/audit");

const router = express.Router();

// POST /api/workbooks  { title }  -> create a new empty workbook
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!isNonEmptyString(title, 200)) {
      return res.status(400).json({ error: "title is required" });
    }

    const result = await db.execute({
      sql: "INSERT INTO workbooks (user_id, title) VALUES (?, ?)",
      args: [req.userId, title],
    });
    const id = Number(result.lastInsertRowid);

    await logAction({ userId: req.userId, action: "workbook.create", entityType: "workbook", entityId: id, details: { title }, ip: req.ip });

    res.status(201).json({ id, title });
  } catch (err) {
    next(err);
  }
});

// GET /api/workbooks  -> list the user's workbooks
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: "SELECT id, title, created_at FROM workbooks WHERE user_id = ? ORDER BY created_at DESC",
      args: [req.userId],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/workbooks/:id  -> workbook details plus the sheets inside it
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const wbResult = await db.execute({
      sql: "SELECT * FROM workbooks WHERE id = ? AND user_id = ?",
      args: [req.params.id, req.userId],
    });
    if (wbResult.rows.length === 0) return res.status(404).json({ error: "workbook not found" });

    const sheetsResult = await db.execute({
      sql: "SELECT id, title, created_at, updated_at FROM spreadsheets WHERE workbook_id = ? ORDER BY created_at ASC",
      args: [req.params.id],
    });

    res.json({ id: wbResult.rows[0].id, title: wbResult.rows[0].title, sheets: sheetsResult.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/workbooks/:id/sheets  { title, columns, rows }  -> add a new sheet/tab to this workbook
router.post("/:id/sheets", requireAuth, async (req, res, next) => {
  try {
    const wbResult = await db.execute({
      sql: "SELECT id FROM workbooks WHERE id = ? AND user_id = ?",
      args: [req.params.id, req.userId],
    });
    if (wbResult.rows.length === 0) return res.status(404).json({ error: "workbook not found" });

    const { title, columns, rows } = req.body;
    if (!isNonEmptyString(title, 200) || !Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ error: "title and non-empty columns[] are required" });
    }

    const result = await db.execute({
      sql: "INSERT INTO spreadsheets (user_id, workbook_id, title, columns_json, rows_json) VALUES (?, ?, ?, ?, ?)",
      args: [req.userId, req.params.id, title, JSON.stringify(columns), JSON.stringify(rows || [])],
    });
    const sheetId = Number(result.lastInsertRowid);

    await logAction({ userId: req.userId, action: "spreadsheet.create", entityType: "spreadsheet", entityId: sheetId, details: { title, workbookId: Number(req.params.id) }, ip: req.ip });

    res.status(201).json({ id: sheetId, title, workbookId: Number(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workbooks/:id  -> delete the workbook (sheets inside stay as standalone sheets, not deleted)
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const wbResult = await db.execute({
      sql: "SELECT id FROM workbooks WHERE id = ? AND user_id = ?",
      args: [req.params.id, req.userId],
    });
    if (wbResult.rows.length === 0) return res.status(404).json({ error: "workbook not found" });

    await db.execute({ sql: "UPDATE spreadsheets SET workbook_id = NULL WHERE workbook_id = ?", args: [req.params.id] });
    await db.execute({ sql: "DELETE FROM workbooks WHERE id = ?", args: [req.params.id] });

    await logAction({ userId: req.userId, action: "workbook.delete", entityType: "workbook", entityId: Number(req.params.id), ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
