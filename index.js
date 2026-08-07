require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { initDb } = require("./db");

const authRoutes = require("./routes/auth");
const extractRoutes = require("./routes/extract");
const spreadsheetRoutes = require("./routes/spreadsheets");
const adminRoutes = require("./routes/admin");
const templateRoutes = require("./routes/templates");
const workbookRoutes = require("./routes/workbooks");
const scheduleRoutes = require("./routes/schedules");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" })); // file uploads go through multipart, not JSON, so this stays small
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// General API rate limit - generous for normal use, blocks abuse/runaway loops
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - please slow down and try again shortly" },
});

// Tighter limit specifically on AI-calling endpoints, since those cost real money per call
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "AI request limit reached for now - please wait a few minutes" },
});

app.use("/api", apiLimiter);
app.use("/api/extract", aiLimiter);
app.use("/api/spreadsheets/build", aiLimiter);
app.use("/api/templates", aiLimiter); // template creation is cheap but keep it under the same guard

app.get("/", (req, res) => res.json({ status: "ok", service: "data-operator-backend" }));
app.get("/health", (req, res) => res.json({ status: "healthy", time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/extract", extractRoutes);
app.use("/api/spreadsheets", spreadsheetRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/workbooks", workbookRoutes);
app.use("/api/schedules", scheduleRoutes);

// 404 handler - anything that didn't match a route above
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// Centralized error handler - every route's next(err) lands here.
// Keeps error responses consistent and keeps internal details out of client-facing messages.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);

  if (err.message?.startsWith("Unsupported image type") || err.message?.startsWith("Expected a PDF")) {
    return res.status(415).json({ error: err.message });
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: "Malformed JSON in request body" });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large (max 15MB)" });
  }

  res.status(500).json({ error: "Something went wrong processing that request. Please try again." });
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
