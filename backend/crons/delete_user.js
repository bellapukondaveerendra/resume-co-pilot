import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve absolute path (IMPORTANT)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Adjust path based on your structure
const dbPath = path.join(__dirname, '../copilot.db');

const db = new DatabaseSync(dbPath);

// Optional: ensure tables exist (safe guard)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT    UNIQUE NOT NULL,
    hash  TEXT    NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Delete all users
const stmt = db.prepare('DELETE FROM users');
const result = stmt.run();

console.log(`✅ Users deleted: ${result.changes}`);