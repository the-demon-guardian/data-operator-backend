const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isNonEmptyString } = require("../utils/validate");

const router = express.Router();

// Static catalog - each entry is a ready-made sheet structure, not tied to any user.
const TEMPLATES = {
  "gst-invoice-log": {
    label: "GST Invoice Log",
    description: "Track invoices with GST breakdown for Indian small businesses",
    columns: ["Invoice No", "Date", "Customer", "GSTIN", "Taxable Amount", "CGST", "SGST", "IGST", "Total", "Status"],
    sampleRows: [],
  },
  "salary-register": {
    label: "Salary Register",
    description: "Monthly salary tracking with deductions",
    columns: ["Employee Name", "Employee ID", "Month", "Basic Pay", "Allowances", "Deductions", "Net Pay", "Payment Date"],
    sampleRows: [],
  },
  "inventory-tracker": {
    label: "Inventory Tracker",
    description: "Stock levels, reorder points, and supplier info",
    columns: ["Item Name", "SKU", "Category", "Quantity in Stock", "Reorder Level", "Unit Price", "Supplier"],
    sampleRows: [],
  },
  "rent-roll": {
    label: "Rent Roll",
    description: "Track rent collection from multiple tenants",
    columns: ["Tenant Name", "Unit", "Monthly Rent", "Due Date", "Amount Paid", "Payment Date", "Status"],
    sampleRows: [],
  },
  "visitor-log": {
    label: "Visitor Log",
    description: "Attendance / visitor sign-in with timestamps",
    columns: ["Name", "Date", "Time", "Purpose"],
    sampleRows: [],
  },
  "expense-tracker": {
    label: "Expense Tracker",
    description: "General business expense tracking by category",
    columns: ["Date", "Category", "Description", "Amount", "Payment Method", "Approved By"],
    sampleRows: [],
  },
};

// GET /api/templates  -> list all available templates (no auth needed, just metadata)
router.get("/", (req, res) => {
  const list = Object.entries(TEMPLATES).map(([key, t]) => ({
    key,
    label: t.label,
    description: t.description,
    columns: t.columns,
  }));
  res.json(list);
});

// POST /api/templates/:key/create  { title? }  -> creates a new spreadsheet from a template
router.post("/:key/create", requireAuth, async (req, res, next) => {
  try {
    const template = TEMPLATES[req.params.key];
    if (!template) return res.status(404).json({ error: `no template named "${req.params.key}"` });

    const { title } = req.body;
    const sheetTitle = isNonEmptyString(title, 200) ? title : template.label;

    const result = await db.execute({
      sql: "INSERT INTO spreadsheets (user_id, title, columns_json, rows_json) VALUES (?, ?, ?, ?)",
      args: [req.userId, sheetTitle, JSON.stringify(template.columns), JSON.stringify(template.sampleRows)],
    });

    res.status(201).json({ id: Number(result.lastInsertRowid), title: sheetTitle, columns: template.columns });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
