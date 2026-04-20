import { query } from "../db.js";

export async function guestRateLimit(req, res, next) {
  const ip = req.ip;
  try {
    const result = await query("SELECT count FROM guest_usage WHERE ip = $1", [ip]);
    const row = result.rows[0];
    if (row && row.count >= 5) {
      return res.status(429).json({ error: "Guest limit reached", code: "GUEST_LIMIT", limit: 5 });
    }
    await query(
      "INSERT INTO guest_usage (ip, count) VALUES ($1, 1) ON CONFLICT (ip) DO UPDATE SET count = guest_usage.count + 1",
      [ip]
    );
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
