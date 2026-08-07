const express = require("express");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { isValidUrl, isNonEmptyString, MAX_TEXT_LENGTH } = require("../utils/validate");
const { EXTRACT_INSTRUCTION, callGemini, extractFromUrl } = require("../utils/extraction");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB - covers scanned invoices and multi-page PDFs
  fileFilter: (req, file, cb) => {
    const allowedImage = ["image/jpeg", "image/png", "image/webp", "image/heic"];
    const allowedPdf = ["application/pdf"];
    if (file.fieldname === "image" && !allowedImage.includes(file.mimetype)) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
    if (file.fieldname === "pdf" && !allowedPdf.includes(file.mimetype)) {
      return cb(new Error(`Expected a PDF, got: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// POST /api/extract/text  { text: "..." }
router.post("/text", requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!isNonEmptyString(text)) {
      return res.status(400).json({ error: `text is required (max ${MAX_TEXT_LENGTH} characters)` });
    }
    const parsed = await callGemini([{ text: `${EXTRACT_INSTRUCTION}\n\nExtract the data from this text:\n\n${text}` }]);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/description  { description: "..." }
router.post("/description", requireAuth, async (req, res, next) => {
  try {
    const { description } = req.body;
    if (!isNonEmptyString(description, 2000)) {
      return res.status(400).json({ error: "description is required (max 2000 characters)" });
    }
    const parsed = await callGemini([
      { text: `${EXTRACT_INSTRUCTION}\n\nBuild the table from this description of what's needed:\n\n${description}` },
    ]);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/image  (multipart/form-data, field name "image")
router.post("/image", requireAuth, upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file is required (field name: image)" });

    const base64 = req.file.buffer.toString("base64");
    const parsed = await callGemini([
      { text: `${EXTRACT_INSTRUCTION}\n\nExtract the data from this image.` },
      { inline_data: { mime_type: req.file.mimetype, data: base64 } },
    ]);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/pdf  (multipart/form-data, field name "pdf")
// Gemini 2.0 Flash accepts PDFs directly as inline data - no separate parsing library needed.
router.post("/pdf", requireAuth, upload.single("pdf"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "pdf file is required (field name: pdf)" });

    const base64 = req.file.buffer.toString("base64");
    const parsed = await callGemini([
      { text: `${EXTRACT_INSTRUCTION}\n\nExtract the data from this PDF document. If it has multiple pages or sections, include all rows.` },
      { inline_data: { mime_type: "application/pdf", data: base64 } },
    ]);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// POST /api/extract/url  { url: "https://..." }
// Actually fetches and reads the page server-side (not just an AI web search guess).
router.post("/url", requireAuth, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!isNonEmptyString(url, 2000) || !isValidUrl(url)) {
      return res.status(400).json({ error: "a valid http(s) url is required" });
    }
    const parsed = await extractFromUrl(url);
    res.json(parsed);
  } catch (err) {
    if (err.message?.includes("fetch failed") || err.cause?.code === "ENOTFOUND") {
      return res.status(422).json({ error: "Could not reach that URL - check it's correct and publicly accessible" });
    }
    if (err.message?.includes("Could not fetch") || err.message?.includes("isn't a readable") || err.message?.includes("Could not extract")) {
      return res.status(422).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
