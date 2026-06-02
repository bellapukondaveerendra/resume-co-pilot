import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const query = (text, params) => pool.query(text, params);

export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        hash          TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: add token_version to pre-existing users tables
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS resumes (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL DEFAULT 'My Resume',
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance    INTEGER NOT NULL DEFAULT 5,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_txns (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta             INTEGER NOT NULL,
        reason            TEXT NOT NULL,
        stripe_payment_id TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS guest_usage (
        id            SERIAL PRIMARY KEY,
        ip            TEXT UNIQUE NOT NULL,
        count         INTEGER NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        id              SERIAL PRIMARY KEY,
        stripe_event_id TEXT UNIQUE NOT NULL,
        processed_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Audit log for credit refunds that couldn't be applied (e.g. DB error
    // during refund). Operators can replay these manually. No FK to users so
    // records survive account deletion.
    await client.query(`
      CREATE TABLE IF NOT EXISTS failed_refunds (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        amount     INTEGER NOT NULL,
        reason     TEXT NOT NULL,
        error_msg  TEXT,
        resolved   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS analysis_history (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_title   TEXT NOT NULL DEFAULT '',
        company     TEXT NOT NULL DEFAULT '',
        match_score INTEGER NOT NULL DEFAULT 0,
        match_label TEXT NOT NULL DEFAULT '',
        result      JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for common query patterns
    await client.query(`CREATE INDEX IF NOT EXISTS idx_resumes_user_id        ON resumes(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_credit_txns_user_id    ON credit_txns(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_analysis_history_user  ON analysis_history(user_id, created_at DESC)`);

    await client.query("COMMIT");
    console.log("Database schema initialized");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
