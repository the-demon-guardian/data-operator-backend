const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isNonEmptyString, MAX_INSTRUCTION_LENGTH } = require("../utils/validate");
const { logAction } = require("../utils/audit");

const router = express.Router();

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const BUILD_INSTRUCTION = `You are an expert spreadsheet designer with experience serving both large enterprises and small offices. The user will describe, in plain language, a spreadsheet they want built - its purpose, the columns/fields it needs, and optionally sample or starter data, formulas, or structure. Design a sensible, professional column layout and 3-5 realistic starter rows that match their intent exactly - the kind of structure an experienced office administrator would set up. If they ask for formulas (totals, averages, etc.), represent that in a "formulas" object mapping a column name to a simple description of the calculation (e.g. "Total": "sum of Amount column") - do not compute actual spreadsheet formula syntax. Respond with ONLY raw JSON, no markdown fences, no commentary, in this exact shape:
{"title": "Suggested title", "columns": ["Col1","Col2"], "rows": [{"Col1":"value","Col2":"value"}], "formulas": {"ColName": "description of calculation"}}`;

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * RBAC core: figures out what role the current user has on a given spreadsheet.
 * Returns "owner", "editor", "viewer", or null (no access at all).
 * Owner is implicit via spreadsheets.user_id; editor/viewer come from the
 * collaborators table added for sharing.
 */
async function getRole(spreadsheetId, userId) {
  const sheetRes = await db.execute({
    sql: "SELECT user_id FROM spreadsheets WHERE id = ?",
    args: [spreadsheetId],
  });
  if (sheetRes.rows.length === 0) return { role: null, exists: false };
  if (sheetRes.rows[0].user_id === userId) return { role: "owner", exists: true };

  const collabRes = await db.execute({
    sql: "SELECT role FROM spreadsheet_collaborators WHERE spreadsheet_id = ? AND user_id = ?",
    args: [spreadsheetId, userId],
  });
  if (collabRes.rows.length === 0) return { role: null, exists: true };
  return { role: collabRes.rows[0].role, exists: true };
}

// POST /api/spreadsheets/build  { instruction: "Create a spreadsheet with columns for..." }
// This is the "AI builds a spreadsheet from a plain instruction" feature.
router.post("/build", requireAuth, async (req, res, next) => {
  try {
    const { instruction } = req.body;
    if (!isNonEmptyString(instruction, MAX_INSTRUCTION_LENGTH)) {
      return res.status(400).json({ error: `instruction is required (max ${MAX_INSTRUCTION_LENGTH} characters)` });
    }

    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${BUILD_INSTRUCTION}\n\nUser's instruction:\n\n${instruction}` }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${errBody.slice(0, 300)}`);
    }
    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no usable content");

    const parsed = extractJson(text);
    if (!Array.isArray(parsed.columns) || parsed.columns.length === 0) {
      return res.status(502).json({ error: "AI response didn't include a valid column layout - try rephrasing" });
    }
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// POST /api/spreadsheets  { title, columns: [...], rows: [...] }  -> save a new spreadsheet
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title, columns, rows } = req.body;
    if (!isNonEmptyString(title, 200) || !Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows)) {
      return res.status(400).json({ error: "title (non-empty), columns[] (non-empty), and rows[] are required" });
    }

    const result = await db.execute({
      sql: "INSERT INTO spreadsheets (user_id, title, columns_json, rows_json) VALUES (?, ?, ?, ?)",
      args: [req.userId, title, JSON.stringify(columns), JSON.stringify(rows)],
    });
    const id = Number(result.lastInsertRowid);

    await logAction({ userId: req.userId, action: "spreadsheet.create", entityType: "spreadsheet", entityId: id, details: { title }, ip: req.ip });

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/spreadsheets  -> list spreadsheets the user owns OR has been given access to
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const result = await db.execute({
      sql: `
        SELECT s.id, s.title, s.created_at, s.updated_at, 'owner' as role
        FROM spreadsheets s WHERE s.user_id = ?
        UNION
        SELECT s.id, s.title, s.created_at, s.updated_at, c.role
        FROM spreadsheets s
        JOIN spreadsheet_collaborators c ON c.spreadsheet_id = s.id
        WHERE c.user_id = ?
        ORDER BY updated_at DESC
      `,
      args: [req.userId, req.userId],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/spreadsheets/:id  -> full spreadsheet (owner, editor, or viewer can read)
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "not found" });
    if (!role) return res.status(403).json({ error: "you don't have access to this spreadsheet" });

    const result = await db.execute({
      sql: "SELECT * FROM spreadsheets WHERE id = ?",
      args: [req.params.id],
    });
    const row = result.rows[0];
    res.json({
      id: row.id,
      title: row.title,
      columns: JSON.parse(row.columns_json),
      rows: JSON.parse(row.rows_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      yourRole: role,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/spreadsheets/:id  { title, columns, rows }  -> update (owner or editor only)
router.put("/:id", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "not found" });
    if (role !== "owner" && role !== "editor") {
      return res.status(403).json({ error: "you have view-only access to this spreadsheet" });
    }

    const { title, columns, rows } = req.body;
    await db.execute({
      sql: `UPDATE spreadsheets SET title = ?, columns_json = ?, rows_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [title, JSON.stringify(columns), JSON.stringify(rows), req.params.id],
    });

    await logAction({ userId: req.userId, action: "spreadsheet.update", entityType: "spreadsheet", entityId: Number(req.params.id), ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/spreadsheets/:id  (owner only)
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "not found" });
    if (role !== "owner") return res.status(403).json({ error: "only the owner can delete this spreadsheet" });

    await db.execute({ sql: "DELETE FROM spreadsheet_collaborators WHERE spreadsheet_id = ?", args: [req.params.id] });
    await db.execute({ sql: "DELETE FROM spreadsheets WHERE id = ?", args: [req.params.id] });

    await logAction({ userId: req.userId, action: "spreadsheet.delete", entityType: "spreadsheet", entityId: Number(req.params.id), ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/spreadsheets/:id/share  { email, role: "editor" | "viewer" }  -> owner only
// Free RBAC: no paid "teams" product, just a row in spreadsheet_collaborators.
router.post("/:id/share", requireAuth, async (req, res, next) => {
  try {
    const { role: callerRole, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "not found" });
    if (callerRole !== "owner") return res.status(403).json({ error: "only the owner can share this spreadsheet" });

    const { email, role } = req.body;
    if (!isNonEmptyString(email, 200) || !["editor", "viewer"].includes(role)) {
      return res.status(400).json({ error: "email and role ('editor' or 'viewer') are required" });
    }

    const userRes = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "no account found with that email" });
    }
    const targetUserId = userRes.rows[0].id;
    if (targetUserId === req.userId) {
      return res.status(400).json({ error: "you already own this spreadsheet" });
    }

    await db.execute({
      sql: `INSERT INTO spreadsheet_collaborators (spreadsheet_id, user_id, role) VALUES (?, ?, ?)
            ON CONFLICT (spreadsheet_id, user_id) DO UPDATE SET role = excluded.role`,
      args: [req.params.id, targetUserId, role],
    });

    await logAction({
      userId: req.userId,
      action: "spreadsheet.share",
      entityType: "spreadsheet",
      entityId: Number(req.params.id),
      details: { sharedWithEmail: email, role },
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/spreadsheets/templates/visitor-log
// Creates a ready-made attendance/visitor log sheet with the right columns pre-built.
router.post("/templates/visitor-log", requireAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    const sheetTitle = isNonEmptyString(title, 200) ? title : "Visitor Log";
    const columns = ["Name", "Date", "Time", "Purpose"];

    const result = await db.execute({
      sql: "INSERT INTO spreadsheets (user_id, title, columns_json, rows_json) VALUES (?, ?, ?, ?)",
      args: [req.userId, sheetTitle, JSON.stringify(columns), JSON.stringify([])],
    });
    const id = Number(result.lastInsertRowid);

    await logAction({ userId: req.userId, action: "spreadsheet.create", entityType: "spreadsheet", entityId: id, details: { template: "visitor-log" }, ip: req.ip });

    res.status(201).json({ id, title: sheetTitle, columns });
  } catch (err) {
    next(err);
  }
});

// POST /api/spreadsheets/:id/quick-entry  { name, extraFields?: { "Purpose": "Meeting" } }
// Appends a row with a SERVER-generated timestamp - not the device clock, so entries
// can't be backdated or tampered with by changing phone time. Owner or editor only.
router.post("/:id/quick-entry", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "spreadsheet not found" });
    if (role !== "owner" && role !== "editor") {
      return res.status(403).json({ error: "you have view-only access to this spreadsheet" });
    }

    const { name, extraFields } = req.body;
    if (!isNonEmptyString(name, 200)) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await db.execute({ sql: "SELECT * FROM spreadsheets WHERE id = ?", args: [req.params.id] });
    const sheet = result.rows[0];
    const columns = JSON.parse(sheet.columns_json);
    const rows = JSON.parse(sheet.rows_json);

    const now = new Date();
    const newRow = {};
    columns.forEach((c) => (newRow[c] = ""));
    newRow["Name"] = name;
    if (columns.includes("Date")) newRow["Date"] = now.toISOString().slice(0, 10);
    if (columns.includes("Time")) newRow["Time"] = now.toTimeString().slice(0, 8);
    if (extraFields && typeof extraFields === "object") {
      Object.entries(extraFields).forEach(([k, v]) => {
        if (columns.includes(k)) newRow[k] = String(v);
      });
    }

    rows.push(newRow);

    await db.execute({
      sql: "UPDATE spreadsheets SET rows_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [JSON.stringify(rows), req.params.id],
    });

    await logAction({
      userId: req.userId,
      action: "spreadsheet.quick_entry",
      entityType: "spreadsheet",
      entityId: Number(req.params.id),
      details: { name },
      ip: req.ip,
    });

    res.status(201).json({ row: newRow, totalRows: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/spreadsheets/:id/audit-log  -> owner only, view the trail for this sheet
router.get("/:id/audit-log", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "not found" });
    if (role !== "owner") return res.status(403).json({ error: "only the owner can view the audit log" });

    const result = await db.execute({
      sql: `SELECT id, user_id, action, details, ip_address, created_at FROM audit_log
            WHERE entity_type = 'spreadsheet' AND entity_id = ? ORDER BY created_at DESC LIMIT 200`,
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

const AI_COMMAND_INSTRUCTION = `You are an AI assistant embedded in a spreadsheet, acting as a professional, experienced data entry operator taking an instruction from your manager. You will be given the current spreadsheet's columns and rows as JSON, plus a plain-language command describing what to do to it.

Decide which of these operation types best fits the command:
- "find_replace": params { column: string|null (null means search all columns), find: string, replace: string }
- "remove_duplicates": params { column: string } - removes rows with a duplicate value in this column, keeping the first occurrence of each
- "sort": params { column: string, direction: "asc"|"desc" }
- "filter": params { column: string, condition: "equals"|"contains"|"greater_than"|"less_than"|"not_empty"|"empty", value: string }
- "add_column": params { name: string, defaultValue: string }
- "remove_column": params { name: string }
- "transform": for anything else - formatting cleanup, standardizing values (dates, phone numbers, capitalization), correcting obvious typos, computing a derived value per row, or any change that doesn't fit the operations above. For this type, directly return the FULL new rows array with your changes applied. Keep the exact same columns and the exact same number of rows unless the command explicitly asks to add or remove rows. Never invent data for fields the command didn't ask you to change - copy those values through unchanged.

Respond with ONLY raw JSON, no markdown fences, no commentary, in exactly ONE of these two shapes:
{"operation": "find_replace" | "remove_duplicates" | "sort" | "filter" | "add_column" | "remove_column", "params": {...}}
{"operation": "transform", "rows": [{"Col1":"value","Col2":"value"}, ...]}`;

function applyDeterministicOperation(operation, params, columns, rows) {
  switch (operation) {
    case "find_replace": {
      const { column, find, replace } = params;
      const targetCols = column ? [column] : columns;
      const newRows = rows.map((r) => {
        const copy = { ...r };
        targetCols.forEach((c) => {
          if (typeof copy[c] === "string") copy[c] = copy[c].split(find).join(replace);
        });
        return copy;
      });
      return { columns, rows: newRows };
    }
    case "remove_duplicates": {
      const { column } = params;
      const seen = new Set();
      const newRows = rows.filter((r) => {
        const key = r[column];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { columns, rows: newRows };
    }
    case "sort": {
      const { column, direction } = params;
      const newRows = [...rows].sort((a, b) => {
        const av = a[column] ?? "";
        const bv = b[column] ?? "";
        const aNum = parseFloat(av);
        const bNum = parseFloat(bv);
        let cmp;
        if (!isNaN(aNum) && !isNaN(bNum) && av !== "" && bv !== "") {
          cmp = aNum - bNum;
        } else {
          cmp = String(av).localeCompare(String(bv));
        }
        return direction === "desc" ? -cmp : cmp;
      });
      return { columns, rows: newRows };
    }
    case "filter": {
      const { column, condition, value } = params;
      const newRows = rows.filter((r) => {
        const cell = r[column] ?? "";
        const cellNum = parseFloat(cell);
        const valNum = parseFloat(value);
        switch (condition) {
          case "equals": return cell === value;
          case "contains": return cell.includes(value);
          case "greater_than": return !isNaN(cellNum) && !isNaN(valNum) && cellNum > valNum;
          case "less_than": return !isNaN(cellNum) && !isNaN(valNum) && cellNum < valNum;
          case "not_empty": return cell.trim() !== "";
          case "empty": return cell.trim() === "";
          default: return true;
        }
      });
      return { columns, rows: newRows };
    }
    case "add_column": {
      const { name, defaultValue } = params;
      if (columns.includes(name)) return { columns, rows };
      const newColumns = [...columns, name];
      const newRows = rows.map((r) => ({ ...r, [name]: defaultValue ?? "" }));
      return { columns: newColumns, rows: newRows };
    }
    case "remove_column": {
      const { name } = params;
      const newColumns = columns.filter((c) => c !== name);
      const newRows = rows.map((r) => {
        const copy = { ...r };
        delete copy[name];
        return copy;
      });
      return { columns: newColumns, rows: newRows };
    }
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// POST /api/spreadsheets/:id/ai-command  { command: "remove duplicate rows by Invoice Number" }
// This is the "AI does the operator's job" feature: a plain-language instruction is
// interpreted by Gemini into either a precise deterministic operation (find/replace,
// dedupe, sort, filter, add/remove column - applied exactly in code, no AI guessing on
// the actual data) or, for open-ended cleanup, a direct AI-applied transform. Owner or
// editor only. Every command is audit-logged with what was requested and what changed.
router.post("/:id/ai-command", requireAuth, async (req, res, next) => {
  try {
    const { role, exists } = await getRole(req.params.id, req.userId);
    if (!exists) return res.status(404).json({ error: "spreadsheet not found" });
    if (role !== "owner" && role !== "editor") {
      return res.status(403).json({ error: "you have view-only access to this spreadsheet" });
    }

    const { command } = req.body;
    if (!isNonEmptyString(command, MAX_INSTRUCTION_LENGTH)) {
      return res.status(400).json({ error: `command is required (max ${MAX_INSTRUCTION_LENGTH} characters)` });
    }

    const sheetRes = await db.execute({ sql: "SELECT * FROM spreadsheets WHERE id = ?", args: [req.params.id] });
    const sheet = sheetRes.rows[0];
    const columns = JSON.parse(sheet.columns_json);
    const rows = JSON.parse(sheet.rows_json);

    if (rows.length > 500) {
      return res.status(413).json({ error: "AI commands support up to 500 rows at a time - filter or paginate first" });
    }

    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${AI_COMMAND_INSTRUCTION}\n\nCurrent columns: ${JSON.stringify(columns)}\nCurrent rows: ${JSON.stringify(rows)}\n\nCommand: ${command}`,
          }],
        }],
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${errBody.slice(0, 300)}`);
    }
    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no usable content");

    const parsed = extractJson(text);
    let result;

    if (parsed.operation === "transform") {
      if (!Array.isArray(parsed.rows)) {
        return res.status(502).json({ error: "AI response didn't include valid row data - try rephrasing the command" });
      }
      result = { columns, rows: parsed.rows };
    } else {
      result = applyDeterministicOperation(parsed.operation, parsed.params || {}, columns, rows);
    }

    await db.execute({
      sql: "UPDATE spreadsheets SET columns_json = ?, rows_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [JSON.stringify(result.columns), JSON.stringify(result.rows), req.params.id],
    });

    await logAction({
      userId: req.userId,
      action: "spreadsheet.ai_command",
      entityType: "spreadsheet",
      entityId: Number(req.params.id),
      details: { command, operation: parsed.operation, rowsBefore: rows.length, rowsAfter: result.rows.length },
      ip: req.ip,
    });

    res.json({ operation: parsed.operation, columns: result.columns, rows: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
