import "dotenv/config";
import crypto from "crypto";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import Stripe from "stripe";
import axios from "axios";
import cron from "node-cron";
import { Resend } from "resend";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { readFileSync } from "node:fs";
import { pool, query, initSchema } from "./db.js";
import { guestRateLimit, GUEST_LIMIT } from "./middleware/rateLimit.js";

// ── Startup env check ──────────────────────────────────────────────────────────

const REQUIRED = ["JWT_SECRET", "DATABASE_URL", "ANTHROPIC_API_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const JWT_SECRET  = process.env.JWT_SECRET;
const PORT        = process.env.PORT || 3001;
const stripe      = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const client      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload      = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const resend      = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
// Sender address for transactional email. Must use a domain you've verified
// in Resend. Override with RESEND_FROM in .env if you change domains later.
const RESET_FROM  = process.env.RESEND_FROM || "Resume CoPilot <support@resumecopilot.in>";

// App mode — when "free", credit gating is bypassed (analyses are unlimited
// for logged-in users). Default is "paid" so forgetting to set it doesn't
// accidentally ship a free version.
const APP_MODE = process.env.APP_MODE === "F" ? "free" : "paid";

// Kill switch for the Anthropic API. When false, /api/analyze short-circuits
// with AI_UNAVAILABLE so users don't wait through long timeouts. Flip to
// "false" the moment you know the AI provider is paused / out of budget;
// flip back to "true" after topping up.
const ANTHROPIC_ENABLED = process.env.ANTHROPIC_ENABLED !== "false";

console.log(`Boot config — mode: ${APP_MODE}, anthropic: ${ANTHROPIC_ENABLED ? "on" : "off"}`);

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,   // SPA manages its own CSP
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  },
}));

// Brute-force protection: 20 attempts per IP per 15 min on auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
});

// Per-user limit on AI-backed import (prevents Anthropic budget abuse).
// Runs AFTER requireAuth so req.user is populated.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: { error: "Too many resume imports this hour. Please try again later." },
});

// Per-IP limit on file extraction (guest-accessible, no auth required).
const extractLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many extract requests this hour. Please try again later." },
});

// ── Stripe webhook (raw body — must be registered BEFORE express.json()) ──────

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Idempotency check
    try {
      const exists = await query("SELECT id FROM stripe_events WHERE stripe_event_id = $1", [event.id]);
      if (exists.rows.length > 0) return res.json({ received: true });

      const { user_id, credits } = session.metadata;
      const userId      = parseInt(user_id, 10);
      const creditCount = parseInt(credits, 10);

      await query(
        "UPDATE credits SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2",
        [creditCount, userId]
      );
      await query(
        "INSERT INTO credit_txns (user_id, delta, reason, stripe_payment_id) VALUES ($1, $2, 'purchase', $3)",
        [userId, creditCount, session.payment_intent]
      );
      await query("INSERT INTO stripe_events (stripe_event_id) VALUES ($1)", [event.id]);
    } catch (err) {
      console.error("Webhook processing error:", err.message);
      return res.status(500).json({ error: "Processing failed" });
    }
  }

  res.json({ received: true });
});

// ── Global middleware ─────────────────────────────────────────────────────────

app.use(express.json({ limit: "2mb" }));

// ── Auth middleware ────────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (typeof payload !== "object" || !payload.id) {
    return res.status(401).json({ error: "Invalid token" });
  }
  try {
    const result = await query("SELECT token_version FROM users WHERE id = $1", [payload.id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const tokenVersion = payload.token_version ?? 0;
    if (tokenVersion !== result.rows[0].token_version) {
      return res.status(401).json({ error: "Token has been revoked", code: "TOKEN_REVOKED" });
    }
    req.user = payload;
    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(500).json({ error: "Authentication failed" });
  }
}

// ── DOCX generation (template-based) ──────────────────────────────────────────
// Reads backend/templates/resume.docx (docxtemplater template with {{tokens}}
// and {{#Loop}}...{{/Loop}} blocks), feeds it data shaped from our internal
// resume schema, then post-processes the rendered XML to wrap LinkedIn/GitHub
// labels in real <w:hyperlink> elements so the links are clickable in Word.

// Map the user's skill categories 1:1 — the template now loops over Skills[]
// and renders one row per category, matching what the preview shows.
function mapSkills(skills) {
  return (skills || [])
    .filter((s) => s?.category || s?.items?.length)
    .map((s) => ({
      category: s.category || "",
      items: (s.items || []).filter(Boolean).join(", "),
    }));
}

// Pick LinkedIn and GitHub from the user's dynamic links array.
// Matches by label OR URL substring (handles "LinkedIn", "linkedin.com/in/...", etc.).
function pickProfileLinks(links) {
  const find = (kw) => (links || []).find((l) =>
    new RegExp(kw, "i").test(l?.label || "") || new RegExp(kw, "i").test(l?.url || "")
  );
  const li = find("linkedin");
  const gh = find("github");
  return {
    ClientLinkedIn:    li?.label || (li?.url ? "LinkedIn" : ""),
    ClientLinkedInURL: li?.url   || "",
    ClientGithub:      gh?.label || (gh?.url ? "GitHub" : ""),
    ClientGithubURL:   gh?.url   || "",
  };
}

// Map experience / projects / education to the loop shapes the template expects.
function mapExperiences(experience) {
  return (experience || []).map((e) => ({
    role:     e?.role     || "",
    company:  e?.company  || "",
    location: e?.location || "",
    start:    e?.start    || "",
    end:      e?.end      || "",
    bullets:  (e?.points || []).filter(Boolean),
  }));
}
function mapProjects(projects) {
  return (projects || []).map((p) => ({
    name:    p?.name || "",
    bullets: (p?.points || []).filter(Boolean),
  }));
}
function mapEducation(education) {
  return (education || []).map((e) => ({
    institution: e?.institution || e?.school || "",
    degree:      e?.degree      || "",
    years:       [e?.start, e?.end].filter(Boolean).join(" – "),
  }));
}

// Post-render XML surgery to turn LinkedIn/GitHub label text into real
// hyperlinks. docxtemplater can't emit <w:hyperlink> natively, so we splice
// it in by finding the rendered <w:r>...<w:t>label</w:t></w:r> run and
// wrapping it. Mirrors the resume_generator.html utility's injectHyperlinks.
function injectHyperlinks(zip, links) {
  const docFile  = zip.file("word/document.xml");
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (!docFile || !relsFile) return;
  let xml  = docFile.asText();
  let rels = relsFile.asText();

  const escAttr = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");

  for (const { text, url, rid } of links) {
    if (!url || !text) continue;
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escAttr(url)}" TargetMode="External"/></Relationships>`
    );
    const variants = [
      `<w:t xml:space="preserve">${text}</w:t></w:r>`,
      `<w:t>${text}</w:t></w:r>`,
    ];
    for (const variant of variants) {
      const idx = xml.indexOf(variant);
      if (idx === -1) continue;
      const runStart = xml.lastIndexOf("<w:r>", idx);
      if (runStart === -1) continue;
      const runEnd  = idx + variant.length;
      const fullRun = xml.substring(runStart, runEnd);
      xml = xml.substring(0, runStart) +
        `<w:hyperlink r:id="${rid}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${fullRun}</w:hyperlink>` +
        xml.substring(runEnd);
      break;
    }
  }

  zip.file("word/document.xml", xml);
  zip.file("word/_rels/document.xml.rels", rels);
}

// Template path resolved at module load. readFileSync per render is cheap
// (37 KB) and avoids stale-cache issues if the template is hot-swapped.
const RESUME_TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "templates", "resume.docx");

async function buildDocx(resume) {
  const { basics = {}, skills = [], experience = [], projects = [], education = [] } = resume || {};

  const profileLinks = pickProfileLinks(basics.links);

  const data = {
    ClientName:     basics.name     || "",
    ClientLocation: basics.location || "",
    ClientPhone:    basics.phone    || "",
    ClientMail:     basics.email    || "",
    ...profileLinks,
    Skills:      mapSkills(skills),
    Experiences: mapExperiences(experience),
    Projects:    mapProjects(projects),
    Education:   mapEducation(education),
  };

  const templateBytes = readFileSync(RESUME_TEMPLATE_PATH);
  const zip = new PizZip(templateBytes);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks:    true,
    delimiters:    { start: "{{", end: "}}" },
  });

  doc.render(data);

  const renderedZip = doc.getZip();
  injectHyperlinks(renderedZip, [
    { text: profileLinks.ClientLinkedIn, url: profileLinks.ClientLinkedInURL, rid: "rIdLinkedIn" },
    { text: profileLinks.ClientGithub,   url: profileLinks.ClientGithubURL,   rid: "rIdGithub"   },
  ]);

  return renderedZip.generate({ type: "nodebuffer" });
}

// ── JSON repair helper ────────────────────────────────────────────────────────
// The AI can return JSON with invalid escape sequences when resume text contains
// Windows paths (C:\Users\...), LaTeX, or other backslash sequences. This tries
// progressively more aggressive repairs before giving up.
// Backend safety net — drop edits the AI returned but the system cannot
// auto-apply. Better to omit a suggestion than ship one that fails to apply.
//   EDIT     — "from" must appear in the resume text (whitespace-insensitive).
//   DELETE   — "statement" must appear in the resume text.
//   ADD      — when structured resume is provided: target must exist AND its
//              bullet count must be below the limit (4 for experience, 3 for
//              projects). When only plain text is available (guest flow):
//              target.name must appear in the resume text.
function filterApplicableEdits(edits, plainText, structured) {
  if (!Array.isArray(edits)) return [];
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedText = norm(plainText);

  const findEntry = (section, name) => {
    if (!structured) return null;
    const arr = section === "experience"
      ? structured.experience
      : section === "projects" ? structured.projects : null;
    if (!Array.isArray(arr)) return null;
    const normName = norm(name);
    if (!normName) return null;
    return arr.find((e) => {
      const candidates = section === "experience" ? [e.company, e.role] : [e.name];
      return candidates.some((c) => c && norm(c) === normName);
    });
  };

  return edits.filter((edit) => {
    if (!edit || typeof edit.type !== "string") return false;

    if (edit.type === "EDIT") {
      if (!edit.from || !edit.to) return false;
      const nf = norm(edit.from);
      return nf.length > 0 && normalizedText.includes(nf);
    }

    if (edit.type === "DELETE") {
      if (!edit.statement) return false;
      const ns = norm(edit.statement);
      return ns.length > 0 && normalizedText.includes(ns);
    }

    if (edit.type === "ADD") {
      if (!edit.statement || !edit.target || !edit.target.section || !edit.target.name) return false;
      const section = edit.target.section;
      if (section !== "experience" && section !== "projects") return false;

      if (structured) {
        // Strict: target entry must exist AND have headroom under the bullet cap.
        const entry = findEntry(section, edit.target.name);
        if (!entry) return false;
        const bulletCount = Array.isArray(entry.points) ? entry.points.length : 0;
        const limit = section === "experience" ? 4 : 3;
        return bulletCount < limit;
      }
      // Loose (guest): target name must appear somewhere in the plain text.
      const nn = norm(edit.target.name);
      return nn.length > 0 && normalizedText.includes(nn);
    }

    return false;
  });
}

function parseAiJson(raw) {
  // Pass 1 — direct parse
  try { return JSON.parse(raw); } catch {}

  // Pass 2 — fix invalid escape sequences: \x where x is not a valid JSON
  // escape character (", \, /, b, f, n, r, t, uXXXX). Replaces with \\x.
  const fixedEscapes = raw.replace(/\\([^"\\/bfnrtu\n\r])/g, "\\\\$1");
  try { return JSON.parse(fixedEscapes); } catch {}

  // Pass 3 — repair truncation: if the response got cut mid-string, close the
  // open string; then close any unclosed brackets/braces. Tracks string state
  // so we don't treat braces inside strings as structural.
  let inString = false;
  let escaped  = false;
  const stack  = [];
  for (const ch of fixedEscapes) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = fixedEscapes;
  if (inString) repaired += '"';
  repaired += stack.reverse().join("");
  return JSON.parse(repaired); // throws if still broken, caught by caller
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Auth — register
// Helper — issue a fresh verification token, store the hash, and send the email.
// Returns true if sent (or if dev fallback logged), false on unrecoverable error.
// Failures are non-blocking: the user can still use the app and request a resend.
async function sendVerificationEmail(userId, email) {
  try {
    const token     = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await query(
      "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, tokenHash, expiresAt]
    );

    const appUrl    = process.env.APP_URL || "http://localhost:5173";
    const verifyUrl = `${appUrl}/verify-email?token=${token}`;

    if (resend) {
      await resend.emails.send({
        from: RESET_FROM,
        to:   email,
        subject: "Welcome to Resume CoPilot — verify your email",
        html: `
          <p>Hi,</p>
          <p>Welcome to Resume CoPilot! Click the link below to verify your email and you're all set.</p>
          <p><a href="${verifyUrl}">Verify my email</a></p>
          <p>This link is valid for 24 hours.</p>
          <p>While we're in beta, the app is fully free — unlimited resume analyses, outreach drafts, and exports.</p>
          <p>If you didn't sign up for Resume CoPilot, you can safely ignore this email.</p>
          <p>— Resume CoPilot</p>
        `,
      });
    } else {
      console.log(`[dev] Email verification link for ${email}: ${verifyUrl}`);
    }
    return true;
  } catch (err) {
    console.error("Verification email error:", err.message);
    return false;
  }
}

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const normalizedEmail = email.toLowerCase().trim();
  const dbClient = await pool.connect();
  try {
    const hash = await bcrypt.hash(password, 10);
    await dbClient.query("BEGIN");
    const result = await dbClient.query(
      "INSERT INTO users (email, hash) VALUES ($1, $2) RETURNING id",
      [normalizedEmail, hash]
    );
    const id = result.rows[0].id;
    await dbClient.query("INSERT INTO credits (user_id, balance) VALUES ($1, 5)", [id]);
    await dbClient.query("COMMIT");

    // Prevent double-dipping: cap this IP's guest usage at GUEST_LIMIT so the
    // new account holder can't bypass credit limits by opening incognito and
    // using guest mode again.
    query(
      "INSERT INTO guest_usage (ip, count) VALUES ($1, $2) ON CONFLICT (ip) DO UPDATE SET count = GREATEST(guest_usage.count, $2)",
      [req.ip, GUEST_LIMIT]
    ).catch(() => {}); // non-critical

    // Fire-and-forget verification email. We don't block signup on its delivery
    // — the user gets a non-blocking banner + a resend button if it fails.
    sendVerificationEmail(id, normalizedEmail).catch(() => {});

    const token = jwt.sign(
      { id, email: normalizedEmail, token_version: 0 },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, user: { id, email: normalizedEmail, email_verified: false } });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  } finally {
    dbClient.release();
  }
});

// Auth — login
app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, token_version: user.token_version ?? 0 },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        email_verified: !!user.email_verified_at,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// Auth — forgot password (send reset email)
// Always returns 200 to prevent email enumeration; logs internally if user missing.
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const userResult = await query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    const user = userResult.rows[0];

    if (user) {
      const token      = crypto.randomBytes(32).toString("hex");
      const tokenHash  = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt  = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [user.id, tokenHash, expiresAt]
      );

      const appUrl    = process.env.APP_URL || "http://localhost:5173";
      const resetLink = `${appUrl}/reset-password?token=${token}`;

      if (resend) {
        try {
          await resend.emails.send({
            from: RESET_FROM,
            to: normalizedEmail,
            subject: "Reset your Resume CoPilot password",
            html: `
              <p>Hi,</p>
              <p>You requested a password reset for your Resume CoPilot account.</p>
              <p>Click the link below to set a new password. This link expires in 15 minutes.</p>
              <p><a href="${resetLink}">Reset password</a></p>
              <p>If you didn't request this, you can safely ignore this email.</p>
              <p>— Resume CoPilot</p>
            `,
          });
        } catch (sendErr) {
          console.error("Resend send error:", sendErr.message);
          // Swallow — generic success below avoids leaking delivery failures.
        }
      } else {
        // Dev fallback when RESEND_API_KEY is unset.
        console.log(`[dev] Password reset link for ${normalizedEmail}: ${resetLink}`);
      }
    }
  } catch (err) {
    console.error("Forgot-password error:", err.message);
  }

  // Always generic success.
  res.json({ ok: true });
});

// Auth — reset password (consume token, change password, bump token_version)
app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Invalid or missing reset token" });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const dbClient  = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const r = await dbClient.query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({ error: "This reset link is invalid or has expired." });
    }

    const hash = await bcrypt.hash(password, 10);
    await dbClient.query(
      "UPDATE users SET hash = $1, token_version = token_version + 1 WHERE id = $2",
      [hash, row.user_id]
    );
    await dbClient.query("UPDATE password_resets SET used = TRUE WHERE id = $1", [row.id]);
    await dbClient.query("COMMIT");

    res.json({ ok: true });
  } catch (err) {
    await dbClient.query("ROLLBACK").catch(() => {});
    console.error("Reset-password error:", err.message);
    res.status(500).json({ error: "Password reset failed. Please try again." });
  } finally {
    dbClient.release();
  }
});

// Auth — verify email (consume token, flip email_verified_at)
// Uses GET so the email link can be clicked directly without a form.
app.get("/api/auth/verify-email", async (req, res) => {
  const { token } = req.query || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Invalid or missing verification token", code: "INVALID" });
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const r = await dbClient.query(
      `SELECT id, user_id FROM email_verifications
       WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash]
    );
    const row = r.rows[0];
    if (!row) {
      await dbClient.query("ROLLBACK");
      // Distinguish "token doesn't exist / used / expired" — all map to the
      // same user message but distinct codes help the frontend decide CTA.
      return res.status(400).json({ error: "This verification link is invalid or has expired.", code: "EXPIRED" });
    }
    await dbClient.query(
      "UPDATE users SET email_verified_at = NOW() WHERE id = $1 AND email_verified_at IS NULL",
      [row.user_id]
    );
    await dbClient.query("UPDATE email_verifications SET used = TRUE WHERE id = $1", [row.id]);
    await dbClient.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await dbClient.query("ROLLBACK").catch(() => {});
    console.error("Verify-email error:", err.message);
    res.status(500).json({ error: "Verification failed. Please try again." });
  } finally {
    dbClient.release();
  }
});

// Auth — resend the verification email (auth required, rate-limited).
app.post("/api/auth/resend-verification", authLimiter, requireAuth, async (req, res) => {
  try {
    const u = await query("SELECT email, email_verified_at FROM users WHERE id = $1", [req.user.id]);
    const row = u.rows[0];
    if (!row) return res.status(404).json({ error: "Account not found" });
    if (row.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
    await sendVerificationEmail(req.user.id, row.email);
    res.json({ ok: true });
  } catch (err) {
    console.error("Resend-verification error:", err.message);
    res.status(500).json({ error: "Couldn't resend verification email. Please try again." });
  }
});

// Auth — current user (lightweight; the frontend uses this to refresh
// verification status after the user clicks the email link in another tab).
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const r = await query("SELECT id, email, email_verified_at FROM users WHERE id = $1", [req.user.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: "Account not found" });
    res.json({
      id: row.id,
      email: row.email,
      email_verified: !!row.email_verified_at,
    });
  } catch (err) {
    console.error("/me error:", err.message);
    res.status(500).json({ error: "Couldn't load account" });
  }
});

// Extract text from PDF or DOCX
app.post("/api/extract", extractLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  const name = req.file.originalname.toLowerCase();
  try {
    let text = "";
    if (name.endsWith(".pdf")) {
      const result = await pdfParse(req.file.buffer);
      text = result.text;
    } else if (name.endsWith(".docx") || name.endsWith(".doc")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: "Only PDF and DOCX files are supported" });
    }
    res.json({ text: text.trim() });
  } catch (err) {
    console.error("Extract error:", err.message);
    res.status(500).json({ error: "Could not extract text from this file. Please try a different file." });
  }
});

// Analyze resume against job — with conditional rate-limiting / atomic credit deduction
app.post("/api/analyze", (req, res, next) => {
  const hasAuth = req.headers.authorization?.startsWith("Bearer ");
  if (hasAuth) requireAuth(req, res, next);
  else guestRateLimit(req, res, next);
}, async (req, res) => {
  const { resumeText, jobInput, inputMode, resumeStructured } = req.body || {};
  if (!resumeText || !jobInput) return res.status(400).json({ error: "Missing resumeText or jobInput" });

  // Kill switch — refuse before doing any work, including credit deduction.
  if (!ANTHROPIC_ENABLED) {
    return res.status(503).json({
      error: "Our AI service is temporarily paused while we top up the budget. Your resume and past analyses are safe.",
      code:  "AI_UNAVAILABLE",
    });
  }

  // ── Atomic credit deduction before AI call (prevents race conditions) ─────
  // Skipped entirely in free mode — credit balance stays untouched, no txn logged.
  let creditsRemaining = null;
  if (req.user && APP_MODE === "paid") {
    try {
      const deduct = await query(
        "UPDATE credits SET balance = balance - 1, updated_at = NOW() WHERE user_id = $1 AND balance > 0 RETURNING balance",
        [req.user.id]
      );
      if (deduct.rows.length === 0) {
        return res.status(402).json({ error: "No credits remaining", code: "NO_CREDITS" });
      }
      creditsRemaining = deduct.rows[0].balance;
    } catch (err) {
      console.error("Credit deduction error:", err.message);
      return res.status(500).json({ error: "Credit check failed" });
    }
  }

  if (process.env.SKIP_AI === "true") {
    return res.json({
      jobTitle: "Senior Backend Engineer",
      company: "Mock Corp",
      fitLevel: "Moderate Fit",
      summary: "Strong backend foundation with real production microservice experience. The biggest opportunities are surfacing Kubernetes/AWS work more prominently and adding concrete scale metrics. Two requirements (Snowflake, Terraform) are not present in the resume and cannot be honestly added.",
      matchedRequirements: [
        "Node.js + React production experience",
        "PostgreSQL data modeling",
        "Microservice architecture",
      ],
      optimizableGaps: [
        "Kubernetes work present but buried inside bullets",
        "AWS coverage exists but isn't surfaced at the top of relevant entries",
        "Quantified impact missing from several recent entries",
      ],
      nonOptimizableGaps: [
        "No Snowflake data warehouse experience anywhere in the resume",
        "No Terraform / IaC work mentioned",
      ],
      edits: [
        { priority: "HIGH", reason: "Surfaces buried Kubernetes work that addresses the JD's container requirement.", type: "EDIT", from: "Worked on backend services", to: "Engineered high-throughput backend services on Node.js / Express handling 10k+ req/sec, deployed via Docker on AWS EKS." },
        { priority: "MEDIUM", reason: "Adds explicit container orchestration coverage where the resume shows the underlying work.", type: "ADD", statement: "Designed and deployed containerized microservices using Docker and Kubernetes on AWS EKS, sustaining 99.9% uptime under production load.", target: { section: "experience", name: "Darwinbox" } },
        { priority: "LOW", reason: "Removes weak filler that undermines senior positioning.", type: "DELETE", statement: "Basic knowledge of programming languages." },
      ],
      linkedinMessage: "Hi, I noticed your opening and would love to connect — my distributed systems background maps well to the role.",
      coldEmail: {
        subject: "Interest in Software Engineer role at Mock Corp",
        body: "Hi,\n\nI came across the Software Engineer opening at Mock Corp and was excited by the focus on distributed systems.\n\nI bring 3+ years building scalable microservices at Darwinbox, where I reduced p99 latency by 70% and achieved 99.9% uptime on Kubernetes. I'd love to bring that experience to your team.\n\nWould you be open to a quick chat?\n\nBest,\nVeerendra",
      },
      coverLetter: {
        subject: "Application for Software Engineer at Mock Corp",
        body: "Dear [Hiring Manager],\n\nI am writing to express my strong interest in the Software Engineer role at Mock Corp. The team's focus on distributed systems and high-availability infrastructure aligns closely with the work I have done over the past three years.\n\nAt Darwinbox, I designed and shipped containerized microservices on Kubernetes that reduced p99 latency by 70% and held 99.9% uptime under production load. I worked across the stack — from API design in Node.js to data modeling in PostgreSQL — and I am comfortable owning a service end to end. The cloud and orchestration skills mentioned in your job description map directly onto the foundation I have built.\n\nI am particularly drawn to Mock Corp's emphasis on engineering rigor and would welcome the chance to contribute. I would be glad to discuss in more detail how my background fits the role and the team's near-term goals.\n\nThank you for your time and consideration. I look forward to hearing from you.\n\nSincerely,\n[Your Name]",
      },
    });
  }

  const jobSection = inputMode === "url"
    ? `JOB POSTING URL: ${jobInput}\n(Infer role and company from the URL context.)`
    : `JOB DESCRIPTION:\n${jobInput}`;

  const prompt = `You are an expert resume OPTIMIZATION coach.

${jobSection}

RESUME:
${resumeText}

--------------------------------------------------
TASK
--------------------------------------------------

You are NOT generating a score. You are helping the user UNDERSTAND and IMPROVE their resume for this specific role.

Your job is to tell the user, clearly:
  1. What the resume already covers
  2. What can be improved through better wording, emphasis, or restructuring
  3. What requirements they genuinely lack and cannot honestly add
  4. The highest-value resume improvements to make

Do NOT optimize for making a number go up.
Optimize for producing the highest-quality, most honest resume guidance.

Return ONLY a valid JSON object (no markdown, no explanations).

--------------------------------------------------
OUTPUT FORMAT
--------------------------------------------------

{
  "jobTitle": "",
  "company": "",
  "fitLevel": "Strong Fit" | "Moderate Fit" | "Weak Fit",
  "summary": "2-3 sentences explaining the overall fit, the candidate's strongest alignments, and their biggest opportunities",

  "matchedRequirements": [
    "specific JD requirements already covered by the resume (max 6)"
  ],
  "optimizableGaps": [
    "gaps that can be improved through resume editing — wording, emphasis, or restructuring (max 6)"
  ],
  "nonOptimizableGaps": [
    "requirements the candidate genuinely lacks based on resume evidence (max 6)"
  ],

  "edits": [
    {
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "reason": "1 sentence — why this edit matters for this role",
      "type": "ADD" | "EDIT" | "DELETE",
      "statement": "for ADD or DELETE",
      "target": {
        "section": "experience" | "projects",
        "name": "exact entry name copied verbatim from the resume"
      },
      "from": "ONLY for EDIT",
      "to": "ONLY for EDIT"
    }
  ],

  "linkedinMessage": "",

  "coldEmail": {
    "subject": "",
    "body": "4-6 sentence professional email"
  },

  "coverLetter": {
    "subject": "Application subject line",
    "body": "3-4 paragraph formal cover letter"
  }
}

--------------------------------------------------
FIT LEVEL RULES
--------------------------------------------------

- "Strong Fit": candidate satisfies MOST core requirements; gaps are minor or optional.
- "Moderate Fit": candidate satisfies SOME important requirements but has meaningful gaps.
- "Weak Fit": candidate lacks MULTIPLE core requirements.

Do NOT use percentages anywhere.
Do NOT generate numerical scores.
Do NOT inflate fit level to make the user feel better.
Be honest. A Weak Fit with great editing guidance is more valuable than a fake Moderate Fit.

--------------------------------------------------
GAP CATEGORIZATION (CRITICAL)
--------------------------------------------------

EVERY gap you identify must go into EXACTLY ONE of these two categories:

OPTIMIZABLE GAPS — improvable through resume editing alone:
  - The candidate did the work but it's buried, weakly worded, or missing keywords
  - Examples:
    * "Leadership work present but not emphasized"
    * "ADR ownership mentioned once, should be highlighted"
    * "gRPC experience buried inside a bullet — surface it"
    * "Kubernetes used but not listed in skills"
    * "Action verbs weak; quantified impact missing"

NON-OPTIMIZABLE GAPS — the candidate genuinely lacks this:
  - No evidence anywhere in the resume that they have this experience
  - Examples:
    * "No Snowflake experience in resume"
    * "No Kotlin code anywhere"
    * "No prior Staff or Principal title"
    * "No ML / data science background"

NEVER fabricate edits to fake non-optimizable gaps.
NEVER move a non-optimizable gap to the optimizable list to soften the message.
The user NEEDS to know what they genuinely lack — that's how they decide whether to apply.

--------------------------------------------------
EDIT PRIORITY RULES
--------------------------------------------------

- "HIGH": directly addresses a core JD requirement that lives in optimizableGaps.
  This is what will most improve the resume's relevance.
- "MEDIUM": improves visibility, ATS keyword coverage, or surfaces buried strengths.
- "LOW": polish, clarity, or formatting only.

Most edits should be HIGH or MEDIUM.
Skip LOW edits unless they're meaningful — don't pad.
Return ONLY edits that address optimizable gaps OR upgrade existing weak content.
Never return an edit that pretends the candidate has experience they lack.

--------------------------------------------------
STRICT RULES
--------------------------------------------------

1. Output STRICTLY valid JSON only.
   - No markdown, no explanations, no extra text.

2. Do NOT hallucinate.
   - Use only information present in the resume.
   - Do not invent experience, tools, metrics, or titles.
   - If unsure, leave fields empty or use "Unknown".

3. Job title and company (CRITICAL):
   - "jobTitle" MUST be a SHORT role title (typically 2-6 words).
     Examples: "Senior Backend Engineer", "Staff Engineer, Platform", "Product Manager".
   - Extract ONLY from explicit role markers near the top of the JD:
       * A header line that visually looks like a title
       * A label like "Role:", "Position:", "Job Title:" followed by the title
       * The HTML <title> tag content (if present)
   - DO NOT extract from sentences, descriptions, or body paragraphs.
     If the candidate text starts with a VERB or pronoun ("Your work will...",
     "You will...", "We are looking for...", "Build...", "Lead...", "Drive..."),
     it is BODY COPY — NEVER a title. Do not extract it.
   - If you cannot find a short, clean role title at the top of the JD,
     set jobTitle to "Unknown Role". DO NOT GUESS, paraphrase, or grab a sentence.
   - "company" follows the same rule: explicit company name only.
     If unclear, use "Unknown Company".

4. EDIT GENERATION POLICY (CRITICAL):
   - ALWAYS prefer EDIT over ADD. ADDs should be RARE.
   - Improvements via better wording, keywords, technology emphasis, architecture
     clarification, leadership visibility, ATS keywords, and metrics are ALMOST
     ALWAYS EDIT operations — not ADDs.
   - Only generate ADD when there is GENUINELY no reasonable way to improve
     an existing statement to cover the gap.
   - Improving existing content beats adding more content.
   - A concise resume with excellent bullets is better than a longer resume
     padded with extra bullets. Avoid bloat.
   - Do NOT force ADD / EDIT / DELETE — include only what's needed.
   - Skip edits when no real improvement exists for an entry.
   - Do NOT generate edits to fake non-optimizable gaps.

5. BULLET COUNT HARD LIMITS:
   - For any experience entry that ALREADY HAS 4 OR MORE bullet points:
     NEVER generate an ADD for that experience. EDIT an existing bullet instead.
   - For any project entry that ALREADY HAS 3 OR MORE bullet points:
     NEVER generate an ADD for that project. EDIT an existing bullet instead.
   - These are HARD limits. Count the bullets in the resume before deciding.

6. APPLICABILITY RULES (CRITICAL — every edit MUST be auto-applicable):
   For EDIT:
   - "from" MUST exactly match text already in the resume — character for character.
   - If an EXACT MATCH cannot be located in the resume text, DO NOT GENERATE the edit.
   For DELETE:
   - "statement" MUST exactly match text from the resume.
   - If no exact match, DO NOT GENERATE.
   For ADD:
   - The target experience or project MUST already exist in the resume.
   - "target.name" MUST exactly match an existing company name (for experience)
     or project name (for projects) — character for character.
   - If the target cannot be identified with certainty, DO NOT GENERATE the edit.

   NEVER generate placeholder edits.
   NEVER generate edits requiring the user to manually copy-paste because the
   system cannot locate the target.
   ONLY return edits the system can automatically apply. It is BETTER to OMIT
   a suggestion than to produce one that cannot be applied.

7. Statement quality (both ADD and EDIT):
   Each statement MUST:
   - Start with a strong action verb (Designed, Engineered, Built, Led, etc.)
   - Describe a system, feature, or problem (not generic tasks)
   - Include relevant technologies or architecture where appropriate
   - Include implementation detail (how it was done)
   - End with clear, measurable impact where the resume already shows that work

8. Per-edit "reason" (REQUIRED):
   - One short sentence (under 100 chars).
   - Plain English: why this edit matters for THIS specific job.

9. Avoid:
   - generic statements (e.g., "worked on", "responsible for")
   - vague impact (e.g., "improved performance" without metrics)
   - repetition or redundant edits
   - any ADD to an entry that already has enough bullets (see rule 5)
   - any edit that fabricates experience the candidate doesn't have
   - any edit you can't guarantee will apply cleanly

10. SUCCESS CRITERIA — the user must leave understanding:
    1. WHY they are a Strong / Moderate / Weak fit
    2. WHICH JD requirements are already covered (matchedRequirements)
    3. WHICH gaps can be improved through editing (optimizableGaps)
    4. WHICH gaps they cannot honestly address (nonOptimizableGaps)
    5. The highest-value resume improvements to make (HIGH-priority edits)

--------------------------------------------------
LINKEDIN MESSAGE RULES
--------------------------------------------------

PERSPECTIVE — CRITICAL:
- The message is written BY THE CANDIDATE (the person whose resume is above)
  TO a potential recipient (recruiter, hiring manager, employee at the company).
- Voice: FIRST PERSON. Use "I" and "my" for the candidate's experience.
- The CANDIDATE is the SENDER. Never address the candidate by name.
  The "Hi [First Name]," placeholder refers to the RECIPIENT — not the candidate.
- BANNED phrasings (these flip the perspective the wrong way):
    * "I'm impressed by your work at [Company in candidate's resume]"
    * "Your background in X is interesting"
    * Anything where "you" / "your" refers to the candidate
  These are wrong because the candidate is the one writing, not being written to.

Structure:
- Maximum 300 characters total.
- Start with: "Hi [First Name]," — recipient's first name, NEVER the candidate's name.
- Reference the specific job title and company (from the JD).
- One sentence describing the candidate's relevant background (from resume) in
  FIRST PERSON: "I built X at Y" or "My work on Z aligns with...".
- End with a soft ask: a quick chat, advice on the role, or a referral.
- Tone: natural, human, conversational — not robotic or salesy.

Placeholders:
- Use ONLY: [First Name] → the recipient's first name.
- Do NOT use [Your Name], [Company Name], [Position], etc.
- Do NOT invent or guess the recipient's actual name.

Do NOT:
- use generic templates
- invent experience not in the resume
- use the candidate's own name in the greeting (they're the sender)
- write in second-person voice about the candidate

--------------------------------------------------
COLD EMAIL RULES
--------------------------------------------------

PERSPECTIVE — CRITICAL:
- Written BY THE CANDIDATE TO a potential recipient (recruiter, hiring manager,
  team lead, or mutual connection found on LinkedIn).
- Voice: FIRST PERSON ("I", "my") when describing the candidate's work.
- Never address the candidate by name. The "[Recipient Name]" placeholder refers
  to the person being emailed.
- BANNED: "Hi [Candidate's Name]," — that flips sender/recipient.
- BANNED: any phrasing where "you" / "your" refers to the candidate's own
  experience or company.

Structure:
- Subject line: specific and role-focused, no buzzwords.
- Greeting: ALWAYS "Hi [Recipient Name]," — never "Hi Hiring Team," / "Dear
  Hiring Manager," / "To Whom It May Concern," / any assumed-role salutation.
- Opening: reference the specific role and company.
- Body: 2-3 sentences only, FIRST PERSON — what the candidate has built / shipped
  that maps to the role (resume-only facts).
- Closing: one soft ask — a brief call, coffee chat, or referral. Low pressure.
- Sign-off: "Best," followed by a blank line. Candidate fills their own name.
- Total length: 4-6 sentences maximum.

Placeholders:
- Use ONLY [Recipient Name] for the greeting.
- Do NOT use [Your Name], [Company Name], [Position], or any other placeholder.
- Do NOT invent or assume the recipient's actual name or role.

--------------------------------------------------
COVER LETTER RULES
--------------------------------------------------

PERSPECTIVE — CRITICAL:
- Written BY THE CANDIDATE TO the hiring team / hiring manager at the company
  in the JD. FIRST PERSON throughout ("I", "my", "I have").
- The candidate is the author. Never address the candidate by name in the
  greeting. The placeholder [Hiring Manager] is the RECIPIENT.

Structure:
- Subject line: "Application for [Role] at [Company]" — use the actual role and company.
- Greeting: "Dear [Hiring Manager]," — never assume a name.
- 3-4 paragraphs:
  - Paragraph 1: state the candidate's interest in the specific role and company; brief hook.
  - Paragraph 2: highlight 2-3 most relevant achievements or skills FROM THE RESUME ONLY
    that align with the JD's stated requirements. First person ("I built…", "I led…").
  - Paragraph 3 (optional): connection to the company's mission, values, or product.
  - Final paragraph: confident close, invite a conversation.
- Sign-off: "Sincerely,\n[Your Name]" — [Your Name] is the CANDIDATE's name placeholder.
- Tone: professional but human, never stiff or generic.
- Length: 250-350 words.
- Use ONLY information present in the resume — never invent experience, metrics, or skills.

Placeholders allowed:
- [Hiring Manager] in greeting (recipient)
- [Your Name] in sign-off (candidate fills their own)
- Do NOT use [Company Name], [Position], or any other placeholder — fill those from the JD.

--------------------------------------------------
QUALITY GUIDELINES
--------------------------------------------------

- MatchScore should reflect real alignment, not inflated
- MatchReasoning must be specific (skills, experience, gaps)
- Keyword gaps must come from the job description
- Outreach messages must feel natural and personalized
`;

  try {
    const message = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 6144,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 30_000 },
    );

    let raw = message.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const parsed = parseAiJson(raw);

    // Safety net: drop any edits the AI returned that the system cannot
    // automatically apply (missing 'from' text, missing target, over-bullet-cap).
    if (Array.isArray(parsed.edits)) {
      const before = parsed.edits.length;
      parsed.edits = filterApplicableEdits(parsed.edits, resumeText, resumeStructured);
      const dropped = before - parsed.edits.length;
      if (dropped > 0) console.log(`filterApplicableEdits dropped ${dropped} of ${before} edits`);
    }

    // Log credit transaction and save analysis to history.
    // match_label column stores fitLevel ("Strong Fit" / "Moderate Fit" / "Weak Fit").
    // match_score column kept for backward-compat with legacy rows but written as 0 for new entries.
    // Credit txn is only logged in paid mode (creditsRemaining is null in free mode).
    if (req.user) {
      if (creditsRemaining !== null) {
        await query(
          "INSERT INTO credit_txns (user_id, delta, reason) VALUES ($1, -1, 'analysis')",
          [req.user.id]
        ).catch((e) => console.error("Credit txn log error:", e.message));
      }

      await query(
        "INSERT INTO analysis_history (user_id, job_title, company, match_score, match_label, result) VALUES ($1, $2, $3, $4, $5, $6)",
        [req.user.id, parsed.jobTitle || "", parsed.company || "", 0, parsed.fitLevel || "", parsed]
      ).catch((e) => console.error("History save error:", e.message));
    }

    res.json({ ...parsed, creditsRemaining });
  } catch (err) {
    // Refund credit if the AI call failed after we already deducted.
    // If the refund itself fails, log it to failed_refunds for manual reconciliation.
    // creditsRemaining is null in free mode, so this is a no-op there.
    if (req.user && creditsRemaining !== null) {
      await query(
        "UPDATE credits SET balance = balance + 1, updated_at = NOW() WHERE user_id = $1",
        [req.user.id]
      ).catch(async (e) => {
        console.error("Credit refund error:", e.message);
        await query(
          "INSERT INTO failed_refunds (user_id, amount, reason, error_msg) VALUES ($1, 1, 'analysis_failed', $2)",
          [req.user.id, e.message]
        ).catch((ee) => console.error("Failed to log refund failure:", ee.message));
      });
    }
    console.error("Analyze error:", err.message);

    // Detect Anthropic provider unavailability (rate limit / overloaded / out of
    // account credit). Surface as AI_UNAVAILABLE so the frontend can show the
    // "AI service paused" modal instead of the generic failure message.
    const aiStatus = err?.status;
    const aiMsg    = String(err?.message || "").toLowerCase();
    const aiType   = err?.error?.type || err?.error?.error?.type;
    const isAiUnavailable =
      aiStatus === 429 || aiStatus === 529 ||
      aiType === "rate_limit_error" || aiType === "overloaded_error" ||
      aiMsg.includes("credit balance") || aiMsg.includes("credit_balance");
    if (isAiUnavailable) {
      return res.status(503).json({
        error: "Our AI service is temporarily paused while we top up the budget. Your resume and past analyses are safe.",
        code:  "AI_UNAVAILABLE",
      });
    }

    const userMsg = err.message?.includes("timed out")
      ? "Analysis timed out — please try again."
      : "Analysis failed. Please try again in a moment.";
    res.status(500).json({ error: userMsg });
  }
});

// Resume — get saved resume (logged-in)
app.get("/api/resume", requireAuth, async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM resumes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.json({ resume: null, name: "My Resume" });
    res.json({ resume: row.data, name: row.name });
  } catch (err) {
    console.error("Get resume error:", err.message);
    res.status(500).json({ error: "Failed to load resume" });
  }
});

// Resume — save/update (logged-in)
app.put("/api/resume", requireAuth, async (req, res) => {
  const { resume, name } = req.body || {};
  if (!resume) return res.status(400).json({ error: "Missing resume data" });
  try {
    const existing = await query("SELECT id FROM resumes WHERE user_id = $1", [req.user.id]);
    if (existing.rows.length > 0) {
      await query(
        "UPDATE resumes SET data = $1, name = $2, updated_at = NOW() WHERE id = $3",
        [resume, name || "My Resume", existing.rows[0].id]
      );
    } else {
      await query(
        "INSERT INTO resumes (user_id, name, data) VALUES ($1, $2, $3)",
        [req.user.id, name || "My Resume", resume]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Save resume error:", err.message);
    res.status(500).json({ error: "Failed to save resume" });
  }
});

// Export DOCX (logged-in)
app.post("/api/export-docx", requireAuth, async (req, res) => {
  const { resume } = req.body || {};
  if (!resume) return res.status(400).json({ error: "Missing resume data" });
  try {
    const buffer = await buildDocx(resume);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": 'attachment; filename="resume.docx"',
    });
    res.send(buffer);
  } catch (err) {
    console.error("Export error:", err.message);
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

// ── Import resume — extract text → LLM → structured JSON ─────────────────────

function str(v) { return typeof v === "string" ? v.trim() : ""; }
function toArr(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
}

function normalizeImportedResume(r) {
  const b = r?.basics || {};
  return {
    basics: {
      name:     str(b.name),
      email:    str(b.email),
      phone:    str(b.phone),
      location: str(b.location),
      links: (b.links || [])
        .map((l) => ({ label: str(l?.label || l?.name || ""), url: str(l?.url || l?.href || "") }))
        .filter((l) => l.label || l.url),
    },
    skills: (r?.skills || [])
      .map((s) => ({ category: str(s?.category), items: toArr(s?.items) }))
      .filter((s) => s.category || s.items.length),
    experience: (r?.experience || []).map((e) => ({
      role:     str(e?.role),
      company:  str(e?.company),
      location: str(e?.location),
      start:    str(e?.start),
      end:      str(e?.end),
      points:   toArr(e?.points),
    })),
    projects: (r?.projects || []).map((p) => ({
      name:   str(p?.name),
      points: toArr(p?.points),
    })),
    education: (r?.education || []).map((e) => ({
      institution: str(e?.institution || e?.school || ""),
      degree:      str(e?.degree),
      start:       str(e?.start),
      end:         str(e?.end),
      coursework:  str(e?.coursework),
    })),
  };
}

const IMPORT_PROMPT = (text) => `You are a resume parser. Your only job is to extract information from the resume text and return a single JSON object.

STRICT RULES:
1. Return ONLY raw JSON — no markdown, no code fences, no explanation, no preamble.
2. Extract ONLY information explicitly present in the resume text. Do NOT infer, guess, or invent anything.
3. If a field is not found, use "" for strings and [] for arrays.
4. Include ALL experiences, projects, education entries, and skill categories found.
5. For dates: copy the exact text (e.g., "May 2024", "2022–2025", "Present").
6. For links: use the label as written (LinkedIn, GitHub, Portfolio, etc.) and include the URL.
7. For skills: preserve existing categories if present. If ungrouped, use one category named "Skills".
8. Bullet points must be copied verbatim — do not paraphrase, summarise, or add to them.
9. Do not alter capitalisation, punctuation, or spelling.

OUTPUT SCHEMA (use exact field names):
{
  "basics": {
    "name": "string",
    "email": "string",
    "phone": "string",
    "location": "string",
    "links": [{ "label": "string", "url": "string" }]
  },
  "skills": [{ "category": "string", "items": ["string"] }],
  "experience": [{
    "role": "string",
    "company": "string",
    "location": "string",
    "start": "string",
    "end": "string",
    "points": ["string"]
  }],
  "projects": [{
    "name": "string",
    "points": ["string"]
  }],
  "education": [{
    "institution": "string",
    "degree": "string",
    "start": "string",
    "end": "string",
    "coursework": "string"
  }]
}

RESUME TEXT:
---
${text}
---

Output the JSON object now:`;

app.post("/api/import-resume", requireAuth, importLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const name = req.file.originalname.toLowerCase();
  let text   = "";

  try {
    if (name.endsWith(".pdf")) {
      const result = await pdfParse(req.file.buffer);
      text = result.text.trim();
    } else if (name.endsWith(".docx") || name.endsWith(".doc")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value.trim();
    } else {
      return res.status(400).json({ error: "Only PDF and DOCX files are supported." });
    }
  } catch (err) {
    console.error("Import read error:", err.message);
    return res.status(422).json({ error: "Could not read this file. Please try a different file." });
  }

  if (!text) {
    return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
  }

  if (process.env.SKIP_AI === "true") {
    return res.json({
      resume: normalizeImportedResume({
        basics: { name: "Test User", email: "test@example.com", phone: "555-1234", location: "San Francisco, CA", links: [{ label: "LinkedIn", url: "https://linkedin.com/in/test" }] },
        skills: [{ category: "Programming", items: ["JavaScript", "Python", "Go"] }],
        experience: [{ role: "Software Engineer", company: "Acme Corp", location: "SF", start: "Jan 2023", end: "Present", points: ["Built scalable APIs", "Reduced latency by 40%"] }],
        projects: [{ name: "OpenMetrics", points: ["Designed distributed metrics collector"] }],
        education: [{ institution: "State University", degree: "B.S. Computer Science", start: "2018", end: "2022", coursework: "Algorithms, Distributed Systems" }],
      }),
    });
  }

  try {
    const message = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [{ role: "user", content: IMPORT_PROMPT(text) }],
      },
      { timeout: 30_000 },
    );

    let raw = message.content.map((b) => b.text || "").join("").trim();
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
      try { parsed = JSON.parse(match[0]); }
      catch { return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." }); }
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
    }

    res.json({ resume: normalizeImportedResume(parsed) });
  } catch (err) {
    console.error("Import error:", err.message);
    res.status(500).json({ error: "Couldn't extract structured data. You can fill it manually." });
  }
});

// ── Credit routes ─────────────────────────────────────────────────────────────

const PACKAGES = {
  starter: { credits: 5,  usd_cents: 250,  inr_paise: 19900, name: "5 Credits – Starter" },
  pro:     { credits: 15, usd_cents: 600,  inr_paise: 49900, name: "15 Credits – Pro" },
  power:   { credits: 40, usd_cents: 1400, inr_paise: 99900, name: "40 Credits – Power" },
};

// In-memory cache: ip → 'usd' | 'inr', evicted after 24h, capped at 10k entries
const _ipCurrencyCache = new Map();
const IP_CACHE_MAX = 10_000;

async function getCurrencyForIP(ip) {
  // Strip IPv6-mapped IPv4 prefix (e.g. ::ffff:1.2.3.4 → 1.2.3.4)
  const clean = ip?.replace(/^::ffff:/, "") ?? "";
  if (!clean || clean === "::1" || clean.startsWith("127.") || clean.startsWith("192.168.") || clean.startsWith("10.")) {
    return "usd"; // local/dev → default USD
  }
  if (_ipCurrencyCache.has(clean)) return _ipCurrencyCache.get(clean);
  try {
    const { data } = await axios.get(`https://ipapi.co/${clean}/json/`, { timeout: 3000 });
    const currency = data.country_code === "IN" ? "inr" : "usd";
    if (_ipCurrencyCache.size >= IP_CACHE_MAX) {
      _ipCurrencyCache.delete(_ipCurrencyCache.keys().next().value); // evict oldest
    }
    _ipCurrencyCache.set(clean, currency);
    setTimeout(() => _ipCurrencyCache.delete(clean), 24 * 60 * 60 * 1000);
    return currency;
  } catch {
    return "usd";
  }
}

function buildPackageList(currency) {
  return Object.entries(PACKAGES).map(([key, p]) => {
    const amount = currency === "inr" ? p.inr_paise : p.usd_cents;
    const price  = currency === "inr"
      ? `₹${p.inr_paise / 100}`
      : `$${(p.usd_cents / 100).toFixed(2)}`;
    const per    = currency === "inr"
      ? `₹${(p.inr_paise / 100 / p.credits).toFixed(2)}/analysis`
      : `$${(p.usd_cents / 100 / p.credits).toFixed(2)}/analysis`;
    return { key, credits: p.credits, name: p.name, price, per_analysis: per, amount, currency };
  });
}

// ── Credit routes ──────────────────────────────────────────────────────────────

app.get("/api/currency", async (req, res) => {
  const currency = await getCurrencyForIP(req.ip);
  res.json({ currency, packages: buildPackageList(currency) });
});

app.get("/api/credits", requireAuth, async (req, res) => {
  try {
    const result = await query("SELECT balance FROM credits WHERE user_id = $1", [req.user.id]);
    const row = result.rows[0];
    res.json({ balance: row ? row.balance : 0 });
  } catch (err) {
    console.error("Get credits error:", err.message);
    res.status(500).json({ error: "Failed to fetch credits" });
  }
});

app.get("/api/credits/history", requireAuth, async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM credit_txns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [req.user.id]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error("Credit history error:", err.message);
    res.status(500).json({ error: "Failed to fetch credit history" });
  }
});

app.post("/api/credits/checkout", requireAuth, async (req, res) => {
  if (APP_MODE === "free") {
    return res.status(503).json({ error: "Currently free — checkout disabled.", code: "FREE_MODE" });
  }
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

  const { package: pkg } = req.body || {};
  const pack = PACKAGES[pkg];
  if (!pack) return res.status(400).json({ error: "Invalid package. Use: starter, pro, or power." });

  try {
    const currency = await getCurrencyForIP(req.ip);
    const amount   = currency === "inr" ? pack.inr_paise : pack.usd_cents;
    const appUrl   = process.env.APP_URL || "http://localhost:5173";
    const session  = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency,
          product_data: { name: pack.name },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      success_url: `${appUrl}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/credits/cancel`,
      metadata: {
        user_id: String(req.user.id),
        package: pkg,
        credits: String(pack.credits),
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Account routes ─────────────────────────────────────────────────────────────

// Permanently delete the user's account. FK CASCADE removes resumes, credits,
// credit_txns, analysis_history, password_resets. failed_refunds has no FK so
// audit log is preserved.
app.delete("/api/account", requireAuth, async (req, res) => {
  try {
    await query("DELETE FROM users WHERE id = $1", [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Account delete error:", err.message);
    res.status(500).json({ error: "Could not delete account. Please try again." });
  }
});

// ── Analysis history routes ────────────────────────────────────────────────────

app.get("/api/analyses", requireAuth, async (req, res) => {
  try {
    const result = await query(
      "SELECT id, job_title, company, match_score, match_label, result, created_at FROM analysis_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30",
      [req.user.id]
    );
    res.json({ analyses: result.rows });
  } catch (err) {
    console.error("Get analyses error:", err.message);
    res.status(500).json({ error: "Failed to fetch analysis history" });
  }
});

app.delete("/api/analyses/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    await query(
      "DELETE FROM analysis_history WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete analysis error:", err.message);
    res.status(500).json({ error: "Failed to delete analysis" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Public app config ─────────────────────────────────────────────────────────
// Frontend fetches this on boot so it can hide paid-flow UI when mode is free.

app.get("/api/config", (_, res) => res.json({ mode: APP_MODE }));

// ── SPA static serving (production) ───────────────────────────────────────────
// When SERVE_STATIC=true, serve the built frontend and fall through to index.html
// for all non-API routes so direct URL access to /privacy, /terms etc. works.
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.SERVE_STATIC === "true") {
  const distPath = join(__dirname, "../frontend/dist");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    const indexPath = join(distPath, "index.html");
    if (existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("Frontend not built. Run: cd frontend && npm run build");
  });
}

// ── Monthly free credit refill ────────────────────────────────────────────────
// Opt-in via ENABLE_MONTHLY_REFILL=true. Runs at 00:00 UTC on the 1st of each
// month. Tops up any user with balance < 2 credits up to 2, and logs each
// top-up as a credit_txn for auditability.
async function runMonthlyRefill() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const insertResult = await c.query(
      `INSERT INTO credit_txns (user_id, delta, reason)
       SELECT user_id, 2 - balance, 'monthly_refill'
       FROM credits WHERE balance < 2
       RETURNING user_id`
    );
    await c.query("UPDATE credits SET balance = 2, updated_at = NOW() WHERE balance < 2");
    await c.query("COMMIT");
    console.log(`Monthly refill: ${insertResult.rowCount} user(s) topped up.`);
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("Monthly refill error:", err.message);
  } finally {
    c.release();
  }
}

if (process.env.ENABLE_MONTHLY_REFILL === "true") {
  cron.schedule("0 0 1 * *", runMonthlyRefill, { timezone: "UTC" });
  console.log("Monthly credit refill scheduled (00:00 UTC on 1st of each month).");
}

// ── Start + graceful shutdown ─────────────────────────────────────────────────

let server;

initSchema()
  .then(() => {
    server = app.listen(PORT, () =>
      console.log(`CoPilot backend running on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err.message);
    process.exit(1);
  });

function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  if (server) {
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // force-exit after 10s
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
