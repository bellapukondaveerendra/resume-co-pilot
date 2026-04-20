import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  TabStopType, BorderStyle, convertInchesToTwip,
} from "docx";

// ── Database ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync("copilot.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT    UNIQUE NOT NULL,
    hash  TEXT    NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS resumes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL DEFAULT 'My Resume',
    data       TEXT    NOT NULL,
    updated_at TEXT    DEFAULT (datetime('now'))
  );
`);

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors({ origin: "http://localhost:5173" }));
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

const FONT = "Georgia";
const BODY = 18;                          //9 pt in half-points
const TAB  = convertInchesToTwip(6.5);   // right tab stop at content width
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

  // Header
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

  // Skills
  const activeSkills = skills.filter(s => s.category || s.items?.length);
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

  // Experience
  if (experience.length) {
    children.push(secHeading("Professional Experience"));
    for (const exp of experience) {
      let title = exp.role || "";
      if (exp.company) title += ` \u2013 ${exp.company}`;
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

  // Projects
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

  // Education
  if (education.length) {
    children.push(secHeading("Education"));
    for (const edu of education) {
      const date = [edu.start, edu.end].filter(Boolean).join(" \u2013 ");
      // backwards-compat: old saved data may use `school`
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
  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare("INSERT INTO users (email, hash) VALUES (?, ?)");
    const result = stmt.run(email.toLowerCase().trim(), hash);
    const id = Number(result.lastInsertRowid);
    const token = jwt.sign({ id, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id, email: email.toLowerCase() } });
  } catch (err) {
    if (err.message?.includes("UNIQUE")) return res.status(409).json({ error: "Email already registered" });
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Auth — login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (!user || !(await bcrypt.compare(password, user.hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email } });
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

// Analyze resume against job
app.post("/api/analyze", async (req, res) => {
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

    let raw = message.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Attempt to close truncated JSON
      const stack = [];
      for (const ch of raw) {
        if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
      raw += stack.reverse().join("");
      parsed = JSON.parse(raw);
    }
    res.json(parsed);
  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ error: "Analysis failed: " + err.message });
  }
});

// Resume — get saved resume (logged-in)
app.get("/api/resume", requireAuth, (req, res) => {
  const row = db.prepare(
    "SELECT * FROM resumes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
  ).get(req.user.id);
  if (!row) return res.json({ resume: null, name: "My Resume" });
  try {
    res.json({ resume: JSON.parse(row.data), name: row.name });
  } catch {
    res.json({ resume: null, name: "My Resume" });
  }
});

// Resume — save/update (logged-in)
app.put("/api/resume", requireAuth, (req, res) => {
  const { resume, name } = req.body || {};
  if (!resume) return res.status(400).json({ error: "Missing resume data" });
  const data = JSON.stringify(resume);
  const existing = db.prepare("SELECT id FROM resumes WHERE user_id = ?").get(req.user.id);
  if (existing) {
    db.prepare(
      "UPDATE resumes SET data = ?, name = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(data, name || "My Resume", existing.id);
  } else {
    db.prepare(
      "INSERT INTO resumes (user_id, name, data) VALUES (?, ?, ?)"
    ).run(req.user.id, name || "My Resume", data);
  }
  res.json({ ok: true });
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
  let text = "";

  // ── 1. Extract plain text ──────────────────────────────────────────────────
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

  // ── 2. SKIP_AI bypass ─────────────────────────────────────────────────────
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

  // ── 3. Call LLM ───────────────────────────────────────────────────────────
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: IMPORT_PROMPT(text) }],
    });

    let raw = message.content.map((b) => b.text || "").join("").trim();

    // Strip accidental markdown fences
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    // ── 4. Parse JSON ────────────────────────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try to salvage by extracting the outermost { ... }
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
      }
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
      }
    }

    // ── 5. Validate and sanitize ─────────────────────────────────────────────
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return res.status(422).json({ error: "Couldn't extract structured data. You can fill it manually." });
    }

    res.json({ resume: normalizeImportedResume(parsed) });
  } catch (err) {
    console.error("Import error:", err.message);
    res.status(500).json({ error: "Couldn't extract structured data. You can fill it manually." });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`CoPilot backend running on http://localhost:${PORT}`));
