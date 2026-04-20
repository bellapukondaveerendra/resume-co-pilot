import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import Stripe from "stripe";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  TabStopType, BorderStyle, convertInchesToTwip,
} from "docx";
import { pool, query, initSchema } from "./db.js";
import { guestRateLimit, authCreditCheck } from "./middleware/rateLimit.js";

// ── Startup env check ──────────────────────────────────────────────────────────

const REQUIRED = ["JWT_SECRET", "DATABASE_URL", "ANTHROPIC_API_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const JWT_SECRET  = process.env.JWT_SECRET;
const PORT        = process.env.PORT || 3001;
const stripe      = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const client      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload      = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  },
}));

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

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
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

// ── Routes ────────────────────────────────────────────────────────────────────

// Auth — register
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
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

    const token = jwt.sign({ id, email: email.toLowerCase().trim() }, JWT_SECRET, { expiresIn: "7d" });
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
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const result = await query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// Extract text from PDF or DOCX
app.post("/api/extract", upload.single("file"), async (req, res) => {
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
    res.status(500).json({ error: "Could not extract text: " + err.message });
  }
});

// Analyze resume against job — with conditional rate-limiting / credit-checking
app.post("/api/analyze", (req, res, next) => {
  const hasAuth = req.headers.authorization?.startsWith("Bearer ");
  if (hasAuth) {
    requireAuth(req, res, () => authCreditCheck(req, res, next));
  } else {
    guestRateLimit(req, res, next);
  }
}, async (req, res) => {
  const { resumeText, jobInput, inputMode } = req.body || {};
  if (!resumeText || !jobInput) return res.status(400).json({ error: "Missing resumeText or jobInput" });

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
      "from": "ONLY for EDIT",
      "to": "ONLY for EDIT"
    }
  ],

  "linkedinMessage": "",

  "coldEmail": {
    "subject": "",
    "body": "4-6 sentence professional email"
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
QUALITY GUIDELINES
--------------------------------------------------

- MatchScore should reflect real alignment, not inflated
- MatchReasoning must be specific (skills, experience, gaps)
- Keyword gaps must come from the job description
- Outreach messages must feel natural and personalized
`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    let raw = message.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const stack = [];
      for (const ch of raw) {
        if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
      raw += stack.reverse().join("");
      parsed = JSON.parse(raw);
    }

    // Deduct 1 credit for authenticated users and return updated balance
    let creditsRemaining = null;
    if (req.user) {
      try {
        const result = await query(
          "UPDATE credits SET balance = balance - 1, updated_at = NOW() WHERE user_id = $1 RETURNING balance",
          [req.user.id]
        );
        creditsRemaining = result.rows[0]?.balance ?? null;
        await query(
          "INSERT INTO credit_txns (user_id, delta, reason) VALUES ($1, -1, 'analysis')",
          [req.user.id]
        );
      } catch (err) {
        console.error("Credit deduction error:", err.message);
        // Non-fatal: user still gets their analysis result
      }
    }

    res.json({ ...parsed, creditsRemaining });
  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ error: "Analysis failed: " + err.message });
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

app.post("/api/import-resume", requireAuth, upload.single("file"), async (req, res) => {
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
    return res.status(422).json({ error: "Could not read file: " + err.message });
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
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: IMPORT_PROMPT(text) }],
    });

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
  starter: { credits: 5,  amount_cents: 250,  name: "5 Credits – Starter" },
  pro:     { credits: 15, amount_cents: 600,  name: "15 Credits – Pro" },
  power:   { credits: 40, amount_cents: 1400, name: "40 Credits – Power" },
};

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
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: pack.name },
          unit_amount: pack.amount_cents,
        },
        quantity: 1,
      }],
      success_url: "http://localhost:5173/credits/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:  "http://localhost:5173/credits/cancel",
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

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────

initSchema()
  .then(() => {
    app.listen(PORT, () =>
      console.error(`CoPilot backend running on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err.message);
    process.exit(1);
  });
