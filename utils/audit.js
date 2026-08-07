const { db } = require("../db");

/**
 * Records an entry in the append-only audit log. Never throws - a logging failure
 * should never break the actual request, so errors here are swallowed and just printed.
 *
 * @param {object} opts
 * @param {number|null} opts.userId
 * @param {string} opts.action - e.g. "login", "spreadsheet.create", "spreadsheet.share"
 * @param {string} [opts.entityType] - e.g. "spreadsheet", "user"
 * @param {number} [opts.entityId]
 * @param {object} [opts.details] - any extra structured context, stored as JSON
 * @param {string} [opts.ip]
 */
async function logAction({ userId, action, entityType, entityId, details, ip }) {
  try {
    await db.execute({
      sql: `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        userId ?? null,
        action,
        entityType ?? null,
        entityId ?? null,
        details ? JSON.stringify(details) : null,
        ip ?? null,
      ],
    });
  } catch (err) {
    console.error("audit log write failed:", err.message);
  }
}

module.exports = { logAction };
