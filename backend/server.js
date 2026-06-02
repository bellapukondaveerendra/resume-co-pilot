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
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  TabStopType, BorderStyle, convertInchesToTwip,
} from "docx";
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
const RESET_FROM  = "Resume CoPilot <noreply@ashborntech.org>";

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

// ── DOCX generation ────────────────────────────────────────────────────────────

const FONT   = "Georgia";
const BODY   = 18;
const TAB    = convertInchesToTwip(6.5);
const MARGIN = convertInchesToTwip(0.75);

function secHeading(text) {
  return new Paragraph({
    spacing: { before: 100, after: 30 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 2 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, font: FONT, size: 20, smallCaps: true })],
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 10, after: 10 },
    children: [new TextRun({ text: String(text || ""), font: FONT, size: BODY })],
  });
}

async function buildDocx(resume) {
  const { basics, skills = [], experience = [], projects = [], education = [] } = resume;
  const children = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: basics.name || "", bold: true, font: FONT, size: 24 })],
    }),
  );

  const contactParts = [basics.location, basics.phone, basics.email].filter(Boolean);
  for (const l of basics.links || []) if (l.label || l.url) contactParts.push(l.label || l.url);
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: contactParts.join(" | "), font: FONT, size: BODY })],
    }),
  );

  const activeSkills = skills.filter((s) => s.category || s.items?.length);
  if (activeSkills.length) {
    children.push(secHeading("Technical Skills"));
    for (const s of activeSkills) {
      children.push(
        new Paragraph({
          spacing: { before: 20, after: 20 },
          children: [
            new TextRun({ text: (s.category || "") + ": ", bold: true, font: FONT, size: BODY }),
            new TextRun({ text: (s.items || []).join(", "), font: FONT, size: BODY }),
          ],
        }),
      );
    }
  }

  if (experience.length) {
    children.push(secHeading("Professional Experience"));
    for (const exp of experience) {
      let title = exp.role || "";
      if (exp.company)  title += ` \u2013 ${exp.company}`;
      if (exp.location) title += `, ${exp.location}`;
      const date = [exp.start, exp.end].filter(Boolean).join(" \u2013 ");
      children.push(
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TAB }],
          spacing: { before: 100, after: 20 },
          children: [
            new TextRun({ text: title, bold: true, font: FONT, size: BODY }),
            ...(date ? [new TextRun({ text: "\t" + date, bold: true, font: FONT, size: BODY })] : []),
          ],
        }),
      );
      for (const pt of exp.points || []) if (pt) children.push(bullet(pt));
    }
  }

  if (projects.length) {
    children.push(secHeading("Projects"));
    for (const proj of projects) {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 20 },
          children: [new TextRun({ text: proj.name || "", bold: true, font: FONT, size: BODY })],
        }),
      );
      for (const pt of proj.points || []) if (pt) children.push(bullet(pt));
    }
  }

  if (education.length) {
    children.push(secHeading("Education"));
    for (const edu of education) {
      const date        = [edu.start, edu.end].filter(Boolean).join(" \u2013 ");
      const institution = edu.institution || edu.school || "";
      children.push(
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: TAB }],
          spacing: { before: 100, after: 20 },
          children: [
            new TextRun({ text: institution, bold: true, font: FONT, size: BODY }),
            ...(date ? [new TextRun({ text: "\t" + date, bold: true, font: FONT, size: BODY })] : []),
          ],
        }),
      );
      if (edu.degree) {
        children.push(
          new Paragraph({
            spacing: { before: 20, after: 20 },
            children: [new TextRun({ text: edu.degree, bold: true, font: FONT, size: BODY })],
          }),
        );
      }
      if (edu.coursework) {
        children.push(
          new Paragraph({
            spacing: { before: 20, after: 20 },
            children: [new TextRun({ text: edu.coursework, font: FONT, size: BODY })],
          }),
        );
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

// ── JSON repair helper ────────────────────────────────────────────────────────
// The AI can return JSON with invalid escape sequences when resume text contains
// Windows paths (C:\Users\...), LaTeX, or other backslash sequences. This tries
// progressively more aggressive repairs before giving up.
function parseAiJson(raw) {
  // Pass 1 — direct parse
  try { return JSON.parse(raw); } catch {}

  // Pass 2 — fix invalid escape sequences: \x where x is not a valid JSON
  // escape character (", \, /, b, f, n, r, t, uXXXX). Replaces with \\x.
  const fixedEscapes = raw.replace(/\\([^"\\/bfnrtu\n\r])/g, "\\\\$1");
  try { return JSON.parse(fixedEscapes); } catch {}

  // Pass 3 — also close any unclosed brackets/braces
  const stack = [];
  for (const ch of fixedEscapes) {
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  const closed = fixedEscapes + stack.reverse().join("");
  return JSON.parse(closed); // throws if still broken, caught by caller
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Auth — register
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const dbClient = await pool.connect();
  try {
    const hash = await bcrypt.hash(password, 10);
    await dbClient.query("BEGIN");
    const result = await dbClient.query(
      "INSERT INTO users (email, hash) VALUES ($1, $2) RETURNING id",
      [email.toLowerCase().trim(), hash]
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

    const token = jwt.sign(
      { id, email: email.toLowerCase().trim(), token_version: 0 },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, user: { id, email: email.toLowerCase().trim() } });
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
    res.json({ token, user: { id: user.id, email: user.email } });
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
  const { resumeText, jobInput, inputMode } = req.body || {};
  if (!resumeText || !jobInput) return res.status(400).json({ error: "Missing resumeText or jobInput" });

  // ── Atomic credit deduction before AI call (prevents race conditions) ─────
  let creditsRemaining = null;
  if (req.user) {
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
      jobTitle: "Software Engineer",
      company: "Mock Corp",
      matchScore: 78,
      matchLabel: "Medium Fit",
      matchReasoning: "Strong backend experience but missing some cloud keywords listed in the job.",
      keywordGaps: ["AWS Lambda", "Docker", "Kubernetes", "Terraform"],
      skillsToHighlight: ["Node.js", "React", "PostgreSQL", "Microservices"],
      edits: [
        { type: "ADD", statement: "Designed and deployed containerized microservices using Docker and Kubernetes on AWS EKS, achieving 99.9% uptime." },
        { type: "EDIT", from: "Worked on backend services", to: "Engineered high-throughput backend services processing 10k+ requests/sec with Node.js and Express." },
        { type: "DELETE", statement: "Basic knowledge of programming languages." },
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

  const prompt = `You are an expert job application coach and resume analyst.

${jobSection}

RESUME:
${resumeText}

--------------------------------------------------
TASK
--------------------------------------------------

Analyze how well the resume matches the job.

Return ONLY a valid JSON object (no markdown, no explanations).

--------------------------------------------------
OUTPUT FORMAT
--------------------------------------------------

{
  "jobTitle": "",
  "company": "",
  "matchScore": number (0-100),
  "matchLabel": "Strong Fit" | "Medium Fit" | "Weak Fit",
  "matchReasoning": "2-3 concise sentences explaining the match",

  "keywordGaps": ["missing keywords or skills from the job (max 8)"],
  "skillsToHighlight": ["relevant skills already present in resume (max 5)"],

  "edits": [
    {
      "type": "ADD" | "EDIT" | "DELETE",
      "statement": "for ADD or DELETE",
      "target": {
        "section": "experience" | "projects",
        "name": "exact company name (for experience) or project name (for projects) copied verbatim from the resume"
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
STRICT RULES
--------------------------------------------------

1. Output STRICTLY valid JSON only.
   - No markdown, no explanations, no extra text.

2. Do NOT hallucinate.
   - Use only information present in the resume.
   - Do not invent experience, tools, or metrics.
   - If unsure, leave fields empty or use "Unknown".

3. Edits:
   - Return 3–8 edits ONLY if meaningful improvements exist.
   - Do NOT force ADD / EDIT / DELETE — include only necessary types.
   - Skip edits if no real improvement can be made.

4. For EDIT and DELETE:
   - "from" or "statement" MUST exactly match text from the resume.
   - EDIT must significantly improve quality, not just rephrase.

5. For BOTH ADD and EDIT:
   Each statement MUST:
   - Start with a strong action verb (Designed, Engineered, Built, Led, etc.)
   - Describe a system, feature, or problem (not generic tasks)
   - Include relevant technologies or architecture where appropriate
   - Include implementation detail (how it was done)
   - End with clear, measurable impact (%, latency, scale, efficiency, etc.)

6. For ADD:
   - Write complete, ATS-optimized, high-impact bullet points.
   - Do not generate generic or filler content.
   - ALWAYS include a "target" field specifying exactly where to insert the bullet:
     - "section": "experience" if it belongs under a job role, "projects" if under a project.
     - "name": copy the company name (for experience) or project name (for projects) EXACTLY
       as it appears in the resume — do not paraphrase or abbreviate.
   - Only target entries that already exist in the resume. Do not invent new entries.

7. Prioritize:
   - High-impact improvements over minor wording changes
   - Job-relevant keyword alignment
   - Clarity + specificity + measurable outcomes

8. Avoid:
   - generic statements (e.g., "worked on", "responsible for")
   - vague impact (e.g., "improved performance" without metrics)
   - repetition or redundant edits

--------------------------------------------------
LINKEDIN MESSAGE RULES
--------------------------------------------------

Generate a personalized LinkedIn connection request message:

- Maximum 300 characters
- Start with: "Hi [First Name],"
- Mention the specific role and company
- Briefly align candidate's experience with the role (based ONLY on resume)
- End with a soft ask (referral or quick chat)
- Keep tone natural, human, and concise (not robotic or salesy)

Placeholders:
- Use ONLY:
  - [First Name] → recipient name
- Do NOT use placeholders like [Your Name], [Company Name], etc.
- Do NOT invent or guess recipient name

Do NOT:
- use generic templates
- invent experience not present in resume
- make the message overly long or salesy

--------------------------------------------------
COLD EMAIL RULES
--------------------------------------------------

Generate a professional cold email that works for ANY recipient — not just hiring teams.
The recipient could be a recruiter, a hiring manager, a senior engineer, a team lead, or
a mutual connection found on LinkedIn. Write it so it reads naturally regardless of who opens it.

- Subject line: specific and role-focused, no buzzwords
- Greeting: ALWAYS use "Hi [Recipient Name]," — never "Hi Hiring Team,", "Dear Hiring Manager,",
  "To Whom It May Concern," or any other assumed-role salutation
- Opening: reference the specific role and company
- Body: 2-3 sentences only — align candidate's relevant experience with the role (based ONLY on resume)
- Closing: one soft ask — a brief call, coffee chat, or referral — keep it low-pressure
- Sign-off: "Best," followed by a blank line (candidate fills their name)
- Total length: 4-6 sentences maximum

Placeholders:
- Use ONLY [Recipient Name] for the greeting
- Do NOT use [Your Name], [Company Name], [Position], or any other placeholder
- Do NOT invent or assume the recipient's name or role

--------------------------------------------------
COVER LETTER RULES
--------------------------------------------------

Generate a formal cover letter the candidate can attach or paste into an application form.

- Subject line: "Application for [Role] at [Company]" — use the actual role and company
- Greeting: "Dear [Hiring Manager]," — never assume a name
- Structure: 3-4 paragraphs
  - Paragraph 1: state interest in the specific role at the specific company; brief hook
  - Paragraph 2: highlight 2-3 most relevant achievements or skills FROM THE RESUME ONLY
    that align with the job's stated requirements
  - Paragraph 3 (optional): connection to the company's stated mission, values, or product
  - Final paragraph: confident close, invite a conversation
- Sign-off: "Sincerely,\n[Your Name]"
- Tone: professional but human, never stiff or generic
- Length: 250-350 words
- Use ONLY information present in the resume — never invent experience, metrics, or skills

Placeholders allowed:
- [Hiring Manager] in greeting
- [Your Name] in sign-off
- Do NOT use [Company Name], [Position], or any other placeholder — fill those from the JD

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
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 30_000 },
    );

    let raw = message.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const parsed = parseAiJson(raw);

    // Log credit transaction and save analysis to history
    if (req.user) {
      await query(
        "INSERT INTO credit_txns (user_id, delta, reason) VALUES ($1, -1, 'analysis')",
        [req.user.id]
      ).catch((e) => console.error("Credit txn log error:", e.message));

      await query(
        "INSERT INTO analysis_history (user_id, job_title, company, match_score, match_label, result) VALUES ($1, $2, $3, $4, $5, $6)",
        [req.user.id, parsed.jobTitle || "", parsed.company || "", parsed.matchScore ?? 0, parsed.matchLabel || "", parsed]
      ).catch((e) => console.error("History save error:", e.message));
    }

    res.json({ ...parsed, creditsRemaining });
  } catch (err) {
    // Refund credit if the AI call failed after we already deducted.
    // If the refund itself fails, log it to failed_refunds for manual reconciliation.
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
