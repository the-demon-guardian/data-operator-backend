const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("../db");
const { logAction } = require("../utils/audit");

const router = express.Router();

router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const existing = await db.execute({
      sql: "SELECT id FROM users WHERE email = ?",
      args: [email],
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "an account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (email, password_hash) VALUES (?, ?)",
      args: [email, passwordHash],
    });

    const userId = Number(result.lastInsertRowid);
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });

    await logAction({ userId, action: "signup", entityType: "user", entityId: userId, ip: req.ip });

    res.status(201).json({ token, userId });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ error: "signup failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const result = await db.execute({
      sql: "SELECT id, password_hash FROM users WHERE email = ?",
      args: [email],
    });
    if (result.rows.length === 0) {
      await logAction({ userId: null, action: "login.failed", details: { email }, ip: req.ip });
      return res.status(401).json({ error: "invalid email or password" });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await logAction({ userId: user.id, action: "login.failed", ip: req.ip });
      return res.status(401).json({ error: "invalid email or password" });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    await logAction({ userId: user.id, action: "login", ip: req.ip });

    res.json({ token, userId: user.id });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "login failed" });
  }
});

module.exports = router;
    
