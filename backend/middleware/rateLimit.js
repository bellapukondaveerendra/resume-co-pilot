import { query } from "../db.js";

// Configurable via env. Falls back to 10 if unset or non-numeric.
export const GUEST_LIMIT = Number.isInteger(parseInt(process.env.GUEST_LIMIT, 10))
  ? parseInt(process.env.GUEST_LIMIT, 10)
  : 10;

export async function guestRateLimit(req, res, next) {
  const ip = req.ip;
  try {
    // Atomic increment + check — prevents race where two concurrent requests
    // both read count<5 and then both increment past the limit.
    const result = await query(
      `INSERT INTO guest_usage (ip, count) VALUES ($1, 1)
       ON CONFLICT (ip) DO UPDATE SET count = guest_usage.count + 1
       RETURNING count`,
      [ip]
    );
    if (result.rows[0].count > GUEST_LIMIT) {
      return res.status(429).json({ error: "Guest limit reached", code: "GUEST_LIMIT", limit: GUEST_LIMIT });
    }
    next();
  } catch (err) {
    console.error("Rate limit error:", err.message);
    next(); // fail open so a DB error doesn't block the user
  }
}

export async function authCreditCheck(req, res, next) {
  try {
    const result = await query("SELECT balance FROM credits WHERE user_id = $1", [req.user.id]);
    const row = result.rows[0];
    if (!row || row.balance <= 0) {
      return res.status(402).json({ error: "No credits remaining", code: "NO_CREDITS" });
    }
    next();
  } catch (err) {
    console.error("Credit check error:", err.message);
    next(); // fail open
  }
}
