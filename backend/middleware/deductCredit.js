import { query } from "../db.js";

export function deductCredit(req, res, next) {
  res.on("finish", async () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        await query(
          "UPDATE credits SET balance = balance - 1, updated_at = NOW() WHERE user_id = $1",
          [req.user.id]
        );
        await query(
          "INSERT INTO credit_txns (user_id, delta, reason) VALUES ($1, -1, 'analysis')",
          [req.user.id]
        );
      } catch (err) {
        console.error("Credit deduction error:", err.message);
      }
    }
  });
  next();
}
