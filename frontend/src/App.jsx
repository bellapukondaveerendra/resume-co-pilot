import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { EMPTY_RESUME, normalizeResume, resumeToHtml, resumeToPlainText } from "./resumeSchema.js";
import ResumeEditor from "./ResumeEditor.jsx";

// ── Auth persistence ──────────────────────────────────────────────────────────
const AUTH_KEY = "copilot_auth";
function loadAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; }
}
function saveAuth(data) { localStorage.setItem(AUTH_KEY, JSON.stringify(data)); }
function clearAuth() { localStorage.removeItem(AUTH_KEY); }

// ── Style constants ───────────────────────────────────────────────────────────
const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap');`;

const PREVIEW_CSS = `
  .rs{background:#fff;color:#111;font-family:'Times New Roman',serif;font-size:12px;line-height:1.35;padding:36px 44px;min-height:100%}
  .resume-header{text-align:center;margin-bottom:14px}
  .resume-header h1{font-size:22px;line-height:1.1;margin-bottom:5px;font-weight:700}
  .contact-line{font-size:11px;line-height:1.5}
  .contact-line a{color:#111;text-decoration:underline}
  .rs section{margin-bottom:12px}
  .rs h2{font-size:12px;font-weight:700;font-variant:small-caps;letter-spacing:.04em;border-bottom:1px solid #111;padding-bottom:2px;margin-bottom:7px}
  .skill-row{margin-bottom:3px;font-size:12px}
  .entry{margin-bottom:9px}
  .entry-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
  .entry-title{flex:1;min-width:0;font-size:12px;line-height:1.3}
  .entry-dates{font-size:12px;white-space:nowrap;text-align:right;flex-shrink:0;padding-left:12px}
  .entry-degree{font-size:12px;margin-top:2px}
  .rs ul{padding-left:16px;margin:4px 0 0}
  .rs li{margin-bottom:3px;font-size:12px;line-height:1.35}
  .detail-lines{margin-top:3px;font-size:12px;line-height:1.35}
  .sep{color:#666}
`;

// ── Shared UI primitives ──────────────────────────────────────────────────────
function PrimaryBtn({ children, onClick, disabled, style = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "#2563EB", border: "none", borderRadius: 8,
        color: "#FFFFFF", fontFamily: "'Roboto',sans-serif", fontWeight: 700, fontSize: 14,
        padding: "10px 20px", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1, transition: "opacity 0.15s", ...style,
      }}
    >
      {children}
    </button>
  );
}

function GhostBtn({ children, onClick, disabled, style = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent", border: "1px solid #E5E7EB", color: "#6B7280",
        borderRadius: 8, padding: "7px 18px", fontSize: 12, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "'Roboto',sans-serif", transition: "all 0.15s",
        opacity: disabled ? 0.5 : 1, ...style,
      }}
    >
      {children}
    </button>
  );
}

function TabBar({ options, value, onChange, disabledValues = [] }) {
  return (
    <div>
      {options.map((opt, i) => {
        const isDisabled = disabledValues.includes(opt.value);
        return (
          <button
            key={opt.value}
            onClick={() => !isDisabled && onChange(opt.value)}
            className={`tab-btn ${value === opt.value ? "active" : ""}`}
            style={{
              borderRadius: i === 0 ? "7px 0 0 7px" : i === options.length - 1 ? "0 7px 7px 0" : 0,
              ...(isDisabled ? { opacity: 0.45, cursor: "not-allowed" } : {}),
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Underline-style tab — still used by GuestPage results
function RightTab({ label, active, onClick, dot }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "relative", background: "none", border: "none",
        borderBottom: `2px solid ${active ? "#2563EB" : "transparent"}`,
        color: active ? "#111827" : "#9CA3AF",
        padding: "11px 20px 10px", fontSize: 12,
        fontWeight: active ? 700 : 500, cursor: "pointer",
        fontFamily: "'Roboto',sans-serif", letterSpacing: "0.04em",
        transition: "color 0.15s, border-color 0.15s", marginBottom: -1,
      }}
    >
      {label}
      {dot && (
        <span style={{
          position: "absolute", top: 9, right: 9,
          width: 5, height: 5, borderRadius: "50%", background: "#059669",
        }} />
      )}
    </button>
  );
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      style={{
        background: copied ? "#ECFDF5" : "transparent",
        border: `1px solid ${copied ? "#6EE7B7" : "#E5E7EB"}`,
        color: copied ? "#059669" : "#6B7280",
        borderRadius: 5, padding: "3px 10px", fontSize: 11,
        cursor: "pointer", fontFamily: "'Roboto',sans-serif", whiteSpace: "nowrap",
      }}
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// ── Apply edit to resume (for EDIT and DELETE cards) ──────────────────────────
function applyEditToResume(resume, edit) {
  const norm = (s) => (s || "").trim().toLowerCase();
  const matches = (a, b) => {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    // First 70 chars as a fuzzy prefix — tolerates minor trailing differences
    return na.includes(nb.slice(0, 70)) || nb.includes(na.slice(0, 70));
  };
  const clone = JSON.parse(JSON.stringify(resume));

  if (edit.type === "EDIT") {
    for (const e of clone.experience) {
      const i = e.points.findIndex((p) => matches(p, edit.from));
      if (i !== -1) { e.points[i] = edit.to; return clone; }
    }
    for (const p of clone.projects) {
      const i = p.points.findIndex((pt) => matches(pt, edit.from));
      if (i !== -1) { p.points[i] = edit.to; return clone; }
    }
    return null; // bullet not found in resume
  }

  if (edit.type === "DELETE") {
    for (const e of clone.experience) {
      const i = e.points.findIndex((p) => matches(p, edit.statement));
      if (i !== -1) { e.points.splice(i, 1); return clone; }
    }
    for (const p of clone.projects) {
      const i = p.points.findIndex((pt) => matches(pt, edit.statement));
      if (i !== -1) { p.points.splice(i, 1); return clone; }
    }
    return null;
  }

  return null; // ADD — copy only, no auto-target
}

// ── Analysis UI components ────────────────────────────────────────────────────
function ScorePill({ score, label }) {
  const color = score >= 75 ? "#059669" : score >= 50 ? "#D97706" : "#DC2626";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 22, fontWeight: 700, color }}>{score}%</span>
      <span style={{
        fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
        color, background: `${color}18`, padding: "3px 10px", borderRadius: 20, border: `1px solid ${color}33`,
      }}>{label}</span>
    </div>
  );
}

function EditCard({ edit, onApply, applied, editorAvailable = true }) {
  const [applyFailed, setApplyFailed] = useState(false);
  const C = {
    ADD:    { bg: "#ECFDF5", border: "#10B981", badge: "#059669" },
    EDIT:   { bg: "#EFF6FF", border: "#3B82F6", badge: "#2563EB" },
    DELETE: { bg: "#FEF2F2", border: "#EF4444", badge: "#DC2626" },
  };
  const c = C[edit.type] || C.ADD;
  const copyText  = edit.type === "EDIT" ? edit.to : edit.statement;
  const canApply  = editorAvailable && (edit.type === "EDIT" || edit.type === "DELETE");

  const handleApply = () => {
    const ok = onApply();
    if (!ok) {
      setApplyFailed(true);
      setTimeout(() => setApplyFailed(false), 2500);
    }
  };

  return (
    <div style={{ background: c.bg, border: "1px solid #E5E7EB", borderLeft: `3px solid ${c.border}`, borderRadius: 10, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: c.badge, background: `${c.badge}1a`, padding: "2px 8px", borderRadius: 4, fontFamily: "'Space Mono',monospace", flexShrink: 0 }}>
          {edit.type}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {canApply && !applied && !applyFailed && (
            <button
              onClick={handleApply}
              style={{
                background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#2563EB",
                borderRadius: 5, padding: "3px 11px", fontSize: 11, fontWeight: 700,
                cursor: "pointer", fontFamily: "'Roboto',sans-serif",
              }}
            >
              Apply →
            </button>
          )}
          {applied     && <span style={{ fontSize: 11, color: "#059669", fontWeight: 700 }}>✓ Applied</span>}
          {applyFailed && <span style={{ fontSize: 11, color: "#DC2626" }}>Not found — copy &amp; paste</span>}
          <CopyBtn text={copyText} />
        </div>
      </div>

      {edit.type === "ADD"    && <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, margin: 0 }}>{edit.statement}</p>}
      {edit.type === "EDIT"   && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <p style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.5, margin: 0, textDecoration: "line-through", fontStyle: "italic" }}>{edit.from}</p>
          <div style={{ display: "flex", gap: 5, alignItems: "flex-start" }}>
            <span style={{ color: "#3B82F6", fontSize: 13, marginTop: 1, flexShrink: 0 }}>→</span>
            <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, margin: 0 }}>{edit.to}</p>
          </div>
        </div>
      )}
      {edit.type === "DELETE" && <p style={{ fontSize: 12, color: "#9CA3AF", lineHeight: 1.6, margin: 0, textDecoration: "line-through" }}>{edit.statement}</p>}
    </div>
  );
}

function AnalysisInsights({ analysis, onReset, onApply, appliedEdits = new Set(), editorAvailable = true }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <p style={{ fontSize: 11, color: "#6B7280", marginBottom: 5 }}>{analysis.jobTitle} · {analysis.company}</p>
          <ScorePill score={analysis.matchScore} label={analysis.matchLabel} />
        </div>
        <GhostBtn onClick={onReset} style={{ fontSize: 11, padding: "5px 12px", flexShrink: 0 }}>← New</GhostBtn>
      </div>

      <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.65, margin: 0 }}>{analysis.matchReasoning}</p>

      {analysis.keywordGaps?.length > 0 && (
        <div>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280", marginBottom: 6 }}>Keyword Gaps</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {analysis.keywordGaps.map((kw, i) => (
              <span key={i} style={{ fontSize: 10, fontFamily: "'Space Mono',monospace", color: "#DC2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 3, padding: "2px 6px" }}>{kw}</span>
            ))}
          </div>
        </div>
      )}

      {analysis.edits?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280", marginBottom: 2 }}>
            {analysis.edits.length} suggested {analysis.edits.length === 1 ? "change" : "changes"}
            <span style={{ color: "#9CA3AF", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {" "}— ADD cards are copy-only
            </span>
          </p>
          {analysis.edits.map((edit, i) => (
            <EditCard
              key={i}
              edit={edit}
              onApply={() => onApply(i, edit)}
              applied={appliedEdits.has(i)}
              editorAvailable={editorAvailable}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Outreach section ──────────────────────────────────────────────────────────
function OutreachSection({ analysis, onGoAnalysis }) {
  if (!analysis) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 8 }}>
        <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.65 }}>
          Run an analysis first to generate outreach messages tailored to the job.
        </p>
        {onGoAnalysis && (
          <GhostBtn onClick={onGoAnalysis} style={{ fontSize: 12, alignSelf: "flex-start" }}>Go to Analysis →</GhostBtn>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 11, color: "#6B7280", margin: 0 }}>{analysis.jobTitle} · {analysis.company}</p>

      {analysis.linkedinMessage && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #E5E7EB", background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>💼</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#2563EB" }}>LinkedIn Message</span>
            </div>
            <CopyBtn text={analysis.linkedinMessage} />
          </div>
          <div style={{ padding: "12px 14px" }}>
            <p style={{ fontSize: 11, color: "#6B7280", marginBottom: 10 }}>Under 300 chars = higher reply rate.</p>
            <div style={{ background: "#F8FAFC", borderRadius: 8, padding: 12, border: "1px solid #E5E7EB" }}>
              <p style={{ fontSize: 13, color: "#111827", lineHeight: 1.75, margin: 0 }}>{analysis.linkedinMessage}</p>
            </div>
          </div>
        </div>
      )}

      {analysis.coldEmail && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #E5E7EB", background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>📧</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C3AED" }}>Cold Email</span>
            </div>
            <CopyBtn text={`Subject: ${analysis.coldEmail.subject}\n\n${analysis.coldEmail.body}`} />
          </div>
          <div style={{ padding: "12px 14px" }}>
            <div style={{ background: "#F8FAFC", borderRadius: 8, padding: 12, border: "1px solid #E5E7EB" }}>
              <p style={{ fontSize: 10, color: "#7C3AED", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                Subject: {analysis.coldEmail.subject}
              </p>
              <div style={{ height: 1, background: "#E5E7EB", marginBottom: 10 }} />
              <p style={{ fontSize: 13, color: "#111827", lineHeight: 1.8, margin: 0, whiteSpace: "pre-line" }}>{analysis.coldEmail.body}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner({ label }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "40px 0" }}>
      <div style={{ width: 48, height: 48, borderRadius: "50%", border: "2px solid #E5E7EB", borderTop: "2px solid #2563EB", animation: "spin 1s linear infinite", position: "relative" }}>
        <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 16 }}>⚡</span>
      </div>
      {label && <p style={{ color: "#6B7280", fontSize: 13, animation: "pulse 2s ease-in-out infinite", margin: 0 }}>{label}</p>}
    </div>
  );
}

// ── JobInputForm (used in GuestPage) ──────────────────────────────────────────
function JobInputForm({ onAnalyze, loading }) {
  const [jobInput, setJobInput] = useState("");
  const [inputMode, setInputMode] = useState("paste");
  const inputStyle = {
    width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10,
    color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px",
    outline: "none", boxSizing: "border-box",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280" }}>Job</span>
        <TabBar
          options={[{ value: "paste", label: "Paste JD" }, { value: "url", label: "Job URL (Coming Soon)" }]}
          value={inputMode}
          onChange={(val) => { if (val !== "url") setInputMode(val); }}
          disabledValues={["url"]}
        />
      </div>
      {inputMode === "paste" ? (
        <>
          <textarea style={{ ...inputStyle, minHeight: 110, resize: "vertical" }} placeholder="Paste the full job description here…" value={jobInput} onChange={(e) => setJobInput(e.target.value)} />
          <p style={{ fontSize: 11, color: "#9CA3AF", margin: 0, lineHeight: 1.5 }}>For best results, paste the full job description.</p>
        </>
      ) : (
        <div style={{ opacity: 0.5, pointerEvents: "none" }}>
          <input disabled style={{ ...inputStyle, cursor: "not-allowed" }} placeholder="https://jobs.lever.co/company/role-id" value="" readOnly />
          <p style={{ fontSize: 11, color: "#6B7280", marginTop: 8, lineHeight: 1.5 }}>We're working on reliable job extraction. For now, please paste the job description manually.</p>
        </div>
      )}
      <PrimaryBtn
        onClick={() => { if (inputMode !== "url") onAnalyze(jobInput.trim(), "paste"); }}
        disabled={loading || !jobInput.trim() || inputMode === "url"}
        style={{ width: "100%", padding: "12px" }}
      >
        {loading ? "Analyzing…" : "Analyze →"}
      </PrimaryBtn>
    </div>
  );
}

// ── Home page ──────────────────────────────────────────────────────────────────
function HomePage({ onGuest, onLogin, auth, onGoEditor }) {
  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 20px" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ display: "inline-block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "#2563EB", background: "#EFF6FF", border: "1px solid #BFDBFE", padding: "4px 14px", borderRadius: 20, marginBottom: 18 }}>
          AI Job Application Co-Pilot
        </div>
        <h1 style={{ fontSize: "clamp(28px,4.5vw,44px)", fontWeight: 700, lineHeight: 1.15, marginBottom: 14, letterSpacing: "-0.02em", color: "#111827" }}>
          Land the job,<br /><span style={{ color: "#059669" }}>not just the interview.</span>
        </h1>
        <p style={{ color: "#6B7280", fontSize: 15, lineHeight: 1.7, maxWidth: 440, margin: "0 auto" }}>
          Instant resume analysis, keyword gap detection, tailored edits, and outreach messages — all from one paste.
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: auth ? "1fr" : "1fr 1fr", gap: 16, maxWidth: auth ? 400 : "100%", margin: auth ? "0 auto" : undefined }}>
        {!auth && (
          <div onClick={onGuest} style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24, cursor: "pointer", transition: "border-color 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#93C5FD")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#E5E7EB")}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>🔍</div>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Analyze Resume</h2>
            <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.6, marginBottom: 16 }}>Upload your resume, paste a job description, and get a match score, keyword gaps, and outreach messages.</p>
            <span style={{ fontSize: 12, color: "#2563EB" }}>No account needed →</span>
          </div>
        )}
        <div onClick={auth ? onGoEditor : onLogin} style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24, cursor: "pointer", transition: "border-color 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#6EE7B7")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#E5E7EB")}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>✏️</div>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Build & Export Resume</h2>
          <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.6, marginBottom: 16 }}>Fill a structured form, analyze against jobs, apply suggestions directly, preview, and export DOCX.</p>
          <span style={{ fontSize: 12, color: "#059669" }}>{auth ? "Open editor →" : "Login required →"}</span>
        </div>
      </div>
    </div>
  );
}

// ── Guest page ─────────────────────────────────────────────────────────────────
function GuestPage({ onBack, onSignUp }) {
  const [step, setStep]             = useState("input");
  const [resumeMode, setResumeMode] = useState("upload");
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [analysis, setAnalysis]     = useState(null);
  const [guestTab, setGuestTab]     = useState("analysis");
  const [error, setError]           = useState("");
  const fileRef = useRef();

  const inputStyle = { width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px", outline: "none", boxSizing: "border-box" };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf") && !name.endsWith(".docx") && !name.endsWith(".doc")) { setError("Only PDF and DOCX files are supported."); return; }
    setResumeFile(file); setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleAnalyze = async (jobInput, inputMode) => {
    setError("");
    let text = resumeText.trim();
    if (resumeMode === "upload") {
      if (!resumeFile) { setError("Please upload a resume file."); return; }
      setStep("loading");
      try { const result = await api.extract(resumeFile); text = result.text; }
      catch (err) { setError("Could not read file: " + err.message); setStep("input"); return; }
    } else {
      if (!text) { setError("Please paste your resume text."); return; }
      setStep("loading");
    }
    try {
      const data = await api.analyze(text, jobInput, inputMode, null);
      setAnalysis(data); setGuestTab("analysis"); setStep("results");
    } catch (err) { setError("Analysis failed: " + err.message); setStep("input"); }
  };

  const resetToInput = () => { setStep("input"); setAnalysis(null); };

  if (step === "loading") return <div style={{ maxWidth: 480, margin: "0 auto", padding: "80px 20px" }}><Spinner label="Analyzing your application…" /></div>;

  if (step === "results" && analysis) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "36px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <button onClick={resetToInput} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", fontFamily: "'Roboto',sans-serif", marginBottom: 8, padding: 0 }}>← New analysis</button>
            <p style={{ fontSize: 11, color: "#6B7280", marginBottom: 6 }}>{analysis.jobTitle} · {analysis.company}</p>
            <ScorePill score={analysis.matchScore} label={analysis.matchLabel} />
          </div>
        </div>
        <div style={{ display: "flex", borderBottom: "1px solid #E5E7EB", marginBottom: 24 }}>
          <RightTab label="Match Analysis" active={guestTab === "analysis"} onClick={() => setGuestTab("analysis")} />
          <RightTab label="Outreach"       active={guestTab === "outreach"} onClick={() => setGuestTab("outreach")} />
        </div>
        {guestTab === "analysis" && <AnalysisInsights analysis={analysis} onReset={resetToInput} editorAvailable={false} />}
        {guestTab === "outreach" && <OutreachSection  analysis={analysis} />}
        <div style={{ marginTop: 36, padding: "18px 22px", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 4 }}>Want to edit and export your resume?</p>
            <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>Create a free account to build, edit, and export DOCX.</p>
          </div>
          <PrimaryBtn onClick={onSignUp} style={{ whiteSpace: "nowrap", padding: "10px 20px", fontSize: 13 }}>Sign up free →</PrimaryBtn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "44px 20px 60px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 24, fontFamily: "'Roboto',sans-serif" }}>← Back</button>
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6, color: "#111827" }}>Analyze Resume</h1>
      <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 28 }}>Upload or paste your resume, then add the job description.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", letterSpacing: "0.1em", textTransform: "uppercase" }}>Resume</label>
            <TabBar options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste Text" }]} value={resumeMode} onChange={setResumeMode} />
          </div>
          {resumeMode === "upload" ? (
            <>
              <button onClick={() => fileRef.current.click()} style={{ width: "100%", background: "transparent", border: `1px dashed ${resumeFile ? "#6EE7B744" : "#D1D5DB"}`, borderRadius: 8, color: resumeFile ? "#059669" : "#9CA3AF", padding: "14px", fontSize: 13, cursor: "pointer", fontFamily: "'Roboto',sans-serif" }}>
                {resumeFile ? `✓ ${resumeFile.name}` : "Click to upload PDF or DOCX"}
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.doc" style={{ display: "none" }} onChange={handleFile} />
            </>
          ) : (
            <textarea style={{ ...inputStyle, minHeight: 140, resize: "vertical" }} placeholder="Paste your resume text here…" value={resumeText} onChange={(e) => setResumeText(e.target.value)} />
          )}
        </div>
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <JobInputForm onAnalyze={handleAnalyze} loading={step === "loading"} />
        </div>
        {error && <p style={{ color: "#DC2626", fontSize: 13, textAlign: "center", background: "#FEF2F2", padding: "10px 16px", borderRadius: 8, border: "1px solid #FECACA", margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

// ── Auth page ──────────────────────────────────────────────────────────────────
function AuthPage({ mode, onAuth, onToggle, onBack }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const inputStyle = { width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px", outline: "none", boxSizing: "border-box" };
  const submit = async () => {
    setError(""); if (!email || !password) { setError("Email and password required."); return; }
    setLoading(true);
    try { const data = mode === "login" ? await api.login(email, password) : await api.register(email, password); onAuth(data); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 24, fontFamily: "'Roboto',sans-serif" }}>← Back</button>
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6, color: "#111827" }}>{mode === "login" ? "Welcome back" : "Create account"}</h1>
      <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 28 }}>{mode === "login" ? "Sign in to access your resume editor." : "Sign up to build and export your resume."}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "At least 6 characters" : "Your password"} style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <p style={{ color: "#DC2626", fontSize: 13, background: "#FEF2F2", padding: "10px 16px", borderRadius: 8, border: "1px solid #FECACA", margin: 0 }}>{error}</p>}
        <PrimaryBtn onClick={submit} disabled={loading} style={{ width: "100%" }}>{loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}</PrimaryBtn>
        <p style={{ fontSize: 13, color: "#6B7280", textAlign: "center" }}>
          {mode === "login" ? "No account? " : "Already have one? "}
          <button onClick={onToggle} style={{ background: "none", border: "none", color: "#2563EB", cursor: "pointer", fontSize: 13, fontFamily: "'Roboto',sans-serif", padding: 0 }}>
            {mode === "login" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ── Confirm modal ──────────────────────────────────────────────────────────────
function ConfirmModal({ title, body, confirmLabel = "Confirm", onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 28, maxWidth: 420, width: "100%", display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 20px 60px rgba(0,0,0,0.12)" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h3>
        <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.65 }}>{body}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <GhostBtn onClick={onCancel}>Cancel</GhostBtn>
          <PrimaryBtn onClick={onConfirm} style={{ padding: "9px 22px", fontSize: 13 }}>{confirmLabel}</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

// ── Stepper — 3-step progress indicator ───────────────────────────────────────
function Stepper({ stage }) {
  const steps = [
    { key: "edit",     label: "Analyze & Edit" },
    { key: "preview",  label: "Preview"        },
    { key: "outreach", label: "Outreach"       },
  ];
  const curr = steps.findIndex((s) => s.key === stage);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {steps.map((step, i) => (
        <Fragment key={step.key}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 700, fontFamily: "'Space Mono',monospace",
              background: i < curr ? "#DBEAFE" : i === curr ? "#2563EB" : "transparent",
              border: `1.5px solid ${i <= curr ? "#2563EB" : "#D1D5DB"}`,
              color: i < curr ? "#2563EB" : i === curr ? "#FFFFFF" : "#9CA3AF",
            }}>
              {i < curr ? "✓" : i + 1}
            </div>
            <span style={{
              fontSize: 10, fontWeight: i === curr ? 700 : 400,
              letterSpacing: "0.07em", textTransform: "uppercase",
              color: i === curr ? "#111827" : i < curr ? "#2563EB" : "#9CA3AF",
            }}>
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ width: 24, height: 1, background: i < curr ? "#BFDBFE" : "#E5E7EB", margin: "0 10px", flexShrink: 0 }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ── Import landing — first-time users only ────────────────────────────────────
function ImportLanding({ onImportFile, importing, importError, onDismissError, onStartFresh }) {
  const fileRef = useRef();
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "64px 20px" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Set up your resume</h1>
        <p style={{ color: "#6B7280", fontSize: 14, lineHeight: 1.7, maxWidth: 380, margin: "0 auto" }}>
          Import an existing resume to auto-fill the form, or start from scratch.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Import card */}
        <div
          onClick={() => !importing && fileRef.current.click()}
          style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24, cursor: importing ? "default" : "pointer", transition: "border-color 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
          onMouseEnter={(e) => { if (!importing) e.currentTarget.style.borderColor = "#93C5FD"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; }}
        >
          <div style={{ fontSize: 28, marginBottom: 12 }}>{importing ? "⏳" : "📄"}</div>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: "#111827" }}>{importing ? "Importing…" : "Import PDF or DOCX"}</h2>
          <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.6 }}>AI reads your resume and prefills the form. You review before saving.</p>
        </div>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.doc" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; if (f) { e.target.value = ""; onImportFile(f); } }} />

        {/* Scratch card */}
        <div
          onClick={() => !importing && onStartFresh()}
          style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 24, cursor: importing ? "default" : "pointer", transition: "border-color 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
          onMouseEnter={(e) => { if (!importing) e.currentTarget.style.borderColor = "#6EE7B7"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; }}
        >
          <div style={{ fontSize: 28, marginBottom: 12 }}>✏️</div>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Start from Scratch</h2>
          <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.6 }}>Fill the structured form manually. Add skills, experience, projects, and more.</p>
        </div>
      </div>

      {importing && <div style={{ paddingBottom: 16 }}><Spinner label="Extracting resume with AI…" /></div>}

      {importError && (
        <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#DC2626", flex: 1, lineHeight: 1.5 }}>{importError}</span>
          <button onClick={onDismissError} style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 16, padding: 0 }}>×</button>
        </div>
      )}
    </div>
  );
}

// ── Export modal ──────────────────────────────────────────────────────────────
function ExportModal({ resume, onExport, onCancel, exporting }) {
  const defaultName = resume.basics?.name
    ? resume.basics.name.trim().replace(/\s+/g, "_") + "_Resume"
    : "Resume";
  const [filename, setFilename] = useState(defaultName);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 28, maxWidth: 400, width: "100%", display: "flex", flexDirection: "column", gap: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.12)" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Export Resume</h3>

        {/* Filename */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280" }}>File Name</label>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            style={{ background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 8, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 13, padding: "10px 12px", outline: "none", width: "100%", boxSizing: "border-box" }}
          />
          <span style={{ fontSize: 10, color: "#6B7280" }}>
            Saves as <strong style={{ color: "#374151" }}>{(filename || "Resume").trim()}.docx</strong>
          </span>
        </div>

        {/* Format selection */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280" }}>Format</label>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1, padding: "12px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, textAlign: "center", background: "#EFF6FF", border: "1px solid #93C5FD", color: "#2563EB" }}>
              DOCX
            </div>
            <div
              title="PDF export coming soon"
              style={{ flex: 1, padding: "12px 0", borderRadius: 8, fontSize: 12, fontWeight: 600, textAlign: "center", background: "transparent", border: "1px solid #E5E7EB", color: "#D1D5DB", cursor: "not-allowed", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}
            >
              <span>PDF</span>
              <span style={{ fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "#D1D5DB" }}>Coming soon</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <GhostBtn onClick={onCancel} disabled={exporting}>Cancel</GhostBtn>
          <PrimaryBtn
            onClick={() => onExport(filename.trim() || "Resume")}
            disabled={exporting || !filename.trim()}
            style={{ padding: "9px 22px", fontSize: 13 }}
          >
            {exporting ? "Exporting…" : "Download →"}
          </PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

// ── Stage nav bar — shared chrome across all 3 stages ─────────────────────────
const NAV = {
  height: 48,
  style: {
    display: "grid", gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center", gap: 12,
    padding: "0 16px", borderBottom: "1px solid #E5E7EB",
    background: "#FFFFFF", flexShrink: 0,
  },
};

// ── Editor page — 3-stage flow ────────────────────────────────────────────────
function EditorPage({ auth }) {
  // ── Lifecycle ─────────────────────────────────────────────────────────────
  const [loadingResume, setLoadingResume] = useState(true);

  // ── Stage ─────────────────────────────────────────────────────────────────
  const [stage, setStage]                     = useState("edit");
  const [showImportLanding, setShowImportLanding] = useState(false);

  // ── Resume ────────────────────────────────────────────────────────────────
  const [resume, setResume]         = useState(EMPTY_RESUME);
  const [resumeName, setResumeName] = useState("My Resume");
  const [isImported, setIsImported] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [exporting, setExporting]   = useState(false);
  const [saveMsg, setSaveMsg]       = useState("");

  // ── Import ────────────────────────────────────────────────────────────────
  const [importing, setImporting]           = useState(false);
  const [importError, setImportError]       = useState("");
  const [pendingImport, setPendingImport]   = useState(null);
  const [importSuccess, setImportSuccess]   = useState(false);
  const importSuccessTimer                  = useRef(null);
  const replaceFileRef                      = useRef();
  const editorScrollRef                     = useRef();

  // ── Export modal ──────────────────────────────────────────────────────────
  const [showExportModal, setShowExportModal] = useState(false);

  // ── Analysis ──────────────────────────────────────────────────────────────
  const [jobInput, setJobInput]             = useState("");
  const [inputMode, setInputMode]           = useState("paste");
  const [analysisStep, setAnalysisStep]     = useState("idle"); // idle | loading | results
  const [analysis, setAnalysis]             = useState(null);
  const [analysisError, setAnalysisError]   = useState("");
  const [appliedEdits, setAppliedEdits]     = useState(new Set());

  // ── Load resume on mount ──────────────────────────────────────────────────
  useEffect(() => {
    api.getResume(auth.token)
      .then(({ resume: r, name }) => {
        if (r) { setResume(normalizeResume(r)); setResumeName(name || "My Resume"); }
        else    { setShowImportLanding(true); }
      })
      .catch(() => setShowImportLanding(true))
      .finally(() => setLoadingResume(false));
  }, []);

  // ── Import handlers ───────────────────────────────────────────────────────
  const hasData = () => !!(resume.basics.name || resume.experience.length || resume.education.length);

  const handleImportFile = async (file) => {
    setImportError("");
    setImporting(true);
    try {
      const { resume: imported } = await api.importResume(file, auth.token);
      const normalized = normalizeResume(imported);
      if (hasData()) { setPendingImport(normalized); }
      else            { applyImport(normalized); }
    } catch (err) {
      setImportError(err.message || "Couldn't extract structured data. You can fill it manually.");
    } finally {
      setImporting(false);
    }
  };

  const applyImport = (importedResume) => {
    setResume(importedResume);
    setIsImported(true);
    setPendingImport(null);
    setShowImportLanding(false);
    setStage("edit");
    // Clear stale analysis; keep jobInput so user can re-analyze quickly
    setAnalysis(null);
    setAnalysisStep("idle");
    setAppliedEdits(new Set());
    // Success banner with auto-dismiss
    setImportSuccess(true);
    if (importSuccessTimer.current) clearTimeout(importSuccessTimer.current);
    importSuccessTimer.current = setTimeout(() => setImportSuccess(false), 7000);
    // Scroll editor back to top
    requestAnimationFrame(() => {
      if (editorScrollRef.current) editorScrollRef.current.scrollTop = 0;
    });
  };

  // ── Resume CRUD ───────────────────────────────────────────────────────────
  const handleChange = (next) => setResume(normalizeResume(next));

  const handleGoPreview = async () => {
    // Strip empty/whitespace-only bullets before previewing
    const cleaned = normalizeResume({
      ...resume,
      experience: resume.experience.map((e) => ({ ...e, points: e.points.filter((p) => p.trim()) })),
      projects:   resume.projects.map((p)   => ({ ...p, points: p.points.filter((pt) => pt.trim()) })),
    });
    setResume(cleaned);
    setSaveMsg("Saving your changes…");
    setSaving(true);
    try {
      await api.saveResume(cleaned, resumeName, auth.token);
      setIsImported(false);
    } catch { /* proceed to preview even if save fails */ }
    finally { setSaving(false); setSaveMsg(""); }
    setStage("preview");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveResume(resume, resumeName, auth.token);
      setSaveMsg("Saved!"); setIsImported(false);
      setTimeout(() => setSaveMsg(""), 2000);
    } catch { setSaveMsg("Save failed"); }
    finally { setSaving(false); }
  };

  const handleExport = async (filename) => {
    setExporting(true);
    try {
      const blob = await api.exportDocx(resume, auth.token);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `${filename || resumeName || "Resume"}.docx`; a.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
    } catch (err) { alert("Export failed: " + err.message); }
    finally { setExporting(false); }
  };

  // ── Analysis handlers ─────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!jobInput.trim()) return;
    if (inputMode === "url") return; // URL input is disabled
    setAnalysisError(""); setAnalysisStep("loading");
    try {
      const text = resumeToPlainText(resume);
      if (!text.trim()) { setAnalysisError("Your resume is empty — fill in the editor first."); setAnalysisStep("idle"); return; }
      const data = await api.analyze(text, jobInput.trim(), inputMode, auth.token);
      setAnalysis(data); setAnalysisStep("results"); setAppliedEdits(new Set());
    } catch (err) { setAnalysisError(err.message); setAnalysisStep("idle"); }
  };

  const handleApplyEdit = (editIdx, edit) => {
    const next = applyEditToResume(resume, edit);
    if (next) { setResume(normalizeResume(next)); setAppliedEdits((prev) => new Set([...prev, editIdx])); return true; }
    return false;
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loadingResume) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 50px)" }}>
        <Spinner label="Loading your resume…" />
      </div>
    );
  }

  // ── Confirm modal (used by both import landing and replace flow) ──────────
  const confirmModal = pendingImport && (
    <ConfirmModal
      title="Replace current resume?"
      body="This will overwrite your current resume data with the imported content. This cannot be undone."
      confirmLabel="Replace Resume"
      onConfirm={() => applyImport(pendingImport)}
      onCancel={() => setPendingImport(null)}
    />
  );

  // ── First-time import landing ─────────────────────────────────────────────
  if (showImportLanding) {
    return (
      <>
        {confirmModal}
        <ImportLanding
          onImportFile={handleImportFile}
          importing={importing}
          importError={importError}
          onDismissError={() => setImportError("")}
          onStartFresh={() => setShowImportLanding(false)}
        />
      </>
    );
  }

  const hasAnalysis = analysisStep === "results" && !!analysis;

  // shared input style for job textarea/input
  const jiStyle = {
    width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10,
    color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 13, padding: "11px 14px",
    outline: "none", boxSizing: "border-box",
  };

  // ── Stage 1: Analyze + Edit ───────────────────────────────────────────────
  if (stage === "edit") {
    return (
      <>
        {confirmModal}

        {/* hidden replace-resume file input */}
        <input
          ref={replaceFileRef}
          type="file"
          accept=".pdf,.docx,.doc"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files[0]; if (f) { e.target.value = ""; handleImportFile(f); } }}
        />

        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>

          {/* Nav bar */}
          <div style={NAV.style} height={NAV.height}>
            {/* Left: resume name */}
            <input
              value={resumeName}
              onChange={(e) => setResumeName(e.target.value)}
              style={{ background: "transparent", border: "none", outline: "none", color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 13, fontWeight: 600, minWidth: 0 }}
              placeholder="Resume name"
            />
            {/* Center: stepper */}
            <Stepper stage="edit" />
            {/* Right: actions */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
              {saveMsg && <span style={{ fontSize: 11, color: saveMsg === "Saved!" ? "#059669" : "#DC2626" }}>{saveMsg}</span>}
              <GhostBtn onClick={() => replaceFileRef.current.click()} disabled={importing} style={{ fontSize: 11, padding: "5px 12px" }}>
                Replace Resume
              </GhostBtn>
              <GhostBtn onClick={handleSave} disabled={saving} style={{ fontSize: 11, padding: "5px 12px" }}>
                {saving ? "Saving…" : "Save"}
              </GhostBtn>
              <PrimaryBtn onClick={handleGoPreview} disabled={saving} style={{ padding: "7px 16px", fontSize: 12 }}>
                {saving ? "Saving…" : "Preview →"}
              </PrimaryBtn>
            </div>
          </div>

          {/* Import success banner */}
          {importSuccess && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "#ECFDF5", borderBottom: "1px solid #BBF7D0", flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: "#059669", flex: 1, lineHeight: 1.5 }}>
                Resume imported successfully. Please review and complete any missing fields before analyzing.
              </span>
              <button
                onClick={() => { setImportSuccess(false); clearTimeout(importSuccessTimer.current); }}
                style={{ background: "none", border: "none", color: "#6EE7B7", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          )}

          {/* Import error banner */}
          {importError && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "#FEF2F2", borderBottom: "1px solid #FECACA", flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: "#DC2626", flex: 1, lineHeight: 1.5 }}>{importError}</span>
              <button onClick={() => setImportError("")} style={{ background: "none", border: "none", color: "#FCA5A5", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* 2-panel body */}
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

            {/* LEFT — Analysis (45%) */}
            <div style={{ flex: "0 0 45%", borderRight: "1px solid #E5E7EB", display: "flex", flexDirection: "column", background: "#F8FAFC", overflow: "hidden" }}>
              <div style={{ padding: "8px 14px", borderBottom: "1px solid #E5E7EB", background: "#FFFFFF", flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9CA3AF" }}>Analysis</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>

                {/* Idle: job input form */}
                {analysisStep === "idle" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <p style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.6, margin: 0 }}>
                      Paste a job description to score your resume and get edit suggestions you can apply directly.
                    </p>
                    {analysisError && (
                      <p style={{ color: "#DC2626", fontSize: 12, margin: 0, background: "#FEF2F2", padding: "8px 12px", borderRadius: 6, border: "1px solid #FECACA" }}>{analysisError}</p>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280" }}>Job</span>
                      <TabBar
                        options={[{ value: "paste", label: "Paste JD" }, { value: "url", label: "Job URL (Coming Soon)" }]}
                        value={inputMode}
                        onChange={(val) => { if (val !== "url") setInputMode(val); }}
                        disabledValues={["url"]}
                      />
                    </div>
                    {inputMode === "paste" ? (
                      <>
                        <textarea style={{ ...jiStyle, minHeight: 140, resize: "vertical" }} placeholder="Paste the full job description here…" value={jobInput} onChange={(e) => setJobInput(e.target.value)} />
                        <p style={{ fontSize: 11, color: "#9CA3AF", margin: 0, lineHeight: 1.5 }}>For best results, paste the full job description.</p>
                      </>
                    ) : (
                      <div style={{ opacity: 0.5, pointerEvents: "none" }}>
                        <input disabled style={{ ...jiStyle, cursor: "not-allowed" }} placeholder="https://jobs.lever.co/company/role-id" value="" readOnly />
                        <p style={{ fontSize: 11, color: "#6B7280", marginTop: 8, lineHeight: 1.5 }}>We're working on reliable job extraction. For now, please paste the job description manually.</p>
                      </div>
                    )}
                    <PrimaryBtn onClick={handleAnalyze} disabled={!jobInput.trim() || inputMode === "url"} style={{ width: "100%", padding: "11px" }}>
                      Analyze →
                    </PrimaryBtn>
                  </div>
                )}

                {/* Loading */}
                {analysisStep === "loading" && <Spinner label="Analyzing your resume…" />}

                {/* Results */}
                {hasAnalysis && (
                  <AnalysisInsights
                    analysis={analysis}
                    onReset={() => { setAnalysis(null); setAnalysisStep("idle"); }}
                    onApply={handleApplyEdit}
                    appliedEdits={appliedEdits}
                  />
                )}
              </div>
            </div>

            {/* RIGHT — Editor (55%) */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#F8FAFC", overflow: "hidden", position: "relative" }}>
              {/* Import overlay */}
              {importing && (
                <div style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(248,250,252,0.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                  <Spinner label="Importing resume and preparing your editor…" />
                </div>
              )}
              <div style={{ padding: "8px 14px", borderBottom: "1px solid #E5E7EB", background: "#FFFFFF", flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9CA3AF" }}>Editor</span>
              </div>
              <div ref={editorScrollRef} style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                <ResumeEditor resume={resume} onChange={handleChange} isImported={isImported} />
              </div>
            </div>

          </div>
        </div>
      </>
    );
  }

  // ── Stage 2: Preview (read-only, full-width) ──────────────────────────────
  if (stage === "preview") {
    return (
      <>
        {showExportModal && (
          <ExportModal
            resume={resume}
            onExport={handleExport}
            onCancel={() => setShowExportModal(false)}
            exporting={exporting}
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>

        {/* Nav bar */}
        <div style={NAV.style}>
          <GhostBtn onClick={() => setStage("edit")} style={{ fontSize: 11, padding: "5px 14px", justifySelf: "start" }}>← Edit</GhostBtn>
          <Stepper stage="preview" />
          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
            <PrimaryBtn onClick={() => setShowExportModal(true)} style={{ fontSize: 11, padding: "7px 14px" }}>Export DOCX</PrimaryBtn>
            <div title={!hasAnalysis ? "Run analysis in Stage 1 to unlock outreach" : ""} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
              <GhostBtn onClick={() => setStage("outreach")} disabled={!hasAnalysis} style={{ fontSize: 11, padding: "5px 12px" }}>
                Outreach →
              </GhostBtn>
              {!hasAnalysis && <span style={{ fontSize: 9, color: "#9CA3AF", letterSpacing: "0.04em" }}>Run analysis first</span>}
            </div>
          </div>
        </div>

        {/* Full-width resume preview */}
        <div style={{ flex: 1, overflowY: "auto", background: "#E2E8F0", padding: "28px 24px" }}>
          <style>{PREVIEW_CSS}</style>
          <div style={{ background: "#fff", maxWidth: 860, margin: "0 auto", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}>
            <div className="rs" dangerouslySetInnerHTML={{ __html: resumeToHtml(resume) }} />
          </div>
        </div>

        </div>
      </>
    );
  }

  // ── Stage 3: Outreach ─────────────────────────────────────────────────────
  if (stage === "outreach") {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>

        {/* Nav bar */}
        <div style={NAV.style}>
          <GhostBtn onClick={() => setStage("preview")} style={{ fontSize: 11, padding: "5px 14px", justifySelf: "start" }}>← Preview</GhostBtn>
          <Stepper stage="outreach" />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryBtn
              onClick={() => { setJobInput(""); setAnalysis(null); setAnalysisStep("idle"); setStage("edit"); }}
              style={{ padding: "7px 16px", fontSize: 12 }}
            >
              Analyze Another Job →
            </PrimaryBtn>
          </div>
        </div>

        {/* Outreach content — full width, scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 24px", maxWidth: 720, width: "100%", margin: "0 auto" }}>
          <OutreachSection analysis={analysis} />
        </div>

      </div>
    );
  }

  return null;
}

// ── Root App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [auth, setAuth]         = useState(loadAuth);
  const [page, setPage]         = useState("home");
  const [authMode, setAuthMode] = useState("login");

  const handleAuth = (data) => { setAuth(data); saveAuth(data); setPage("editor"); };
  const handleLogout = () => { setAuth(null); clearAuth(); setPage("home"); };
  const goLogin    = () => { setAuthMode("login");    setPage("login"); };
  const goRegister = () => { setAuthMode("register"); setPage("login"); };

  return (
    <>
      <style>{`
        ${FONTS}
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #F8FAFC; overflow-x: hidden; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #F1F5F9; }
        ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        input::placeholder, textarea::placeholder { color: #9CA3AF; }
        input:focus, textarea:focus { border-color: #2563EB !important; }
        .fade-in { animation: fadeIn 0.3s ease forwards; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes pulse  { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        .tab-btn { background:transparent; border:1px solid #E5E7EB; color:#6B7280; cursor:pointer; padding:6px 16px; font-size:11px; font-family:'Roboto',sans-serif; font-weight:500; letter-spacing:0.04em; text-transform:uppercase; transition:all 0.15s; }
        .tab-btn.active { background:#EFF6FF; border-color:#93C5FD; color:#2563EB; }
        ${PREVIEW_CSS}
      `}</style>

      <div style={{ background: "#F8FAFC", minHeight: "100vh", color: "#111827", fontFamily: "'Roboto',sans-serif" }}>

        {/* Navbar */}
        <div style={{ borderBottom: "1px solid #E5E7EB", padding: "13px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#FFFFFF", zIndex: 20 }}>
          <button onClick={() => setPage("home")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14, color: "#111827" }}>CoPilot</span>
          </button>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {auth ? (
              <>
                <span style={{ fontSize: 12, color: "#6B7280" }}>{auth.user?.email}</span>
                <GhostBtn onClick={handleLogout} style={{ fontSize: 12, padding: "5px 14px" }}>Logout</GhostBtn>
              </>
            ) : (
              <>
                <GhostBtn onClick={goLogin}    style={{ fontSize: 12, padding: "5px 14px" }}>Login</GhostBtn>
                <PrimaryBtn onClick={goRegister} style={{ fontSize: 12, padding: "6px 16px" }}>Sign Up</PrimaryBtn>
              </>
            )}
          </div>
        </div>

        {/* Pages */}
        <div className="fade-in" key={page}>
          {page === "home"   && <HomePage auth={auth} onGuest={() => setPage("guest")} onLogin={goLogin} onGoEditor={() => setPage("editor")} />}
          {page === "guest"  && <GuestPage onBack={() => setPage("home")} onSignUp={goRegister} />}
          {page === "login"  && (
            <AuthPage
              mode={authMode}
              onAuth={handleAuth}
              onToggle={() => setAuthMode(authMode === "login" ? "register" : "login")}
              onBack={() => setPage("home")}
            />
          )}
          {page === "editor" &&  auth && <EditorPage auth={auth} />}
          {page === "editor" && !auth && (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <p style={{ color: "#6B7280", marginBottom: 16 }}>Please log in to access the editor.</p>
              <PrimaryBtn onClick={goLogin}>Login</PrimaryBtn>
            </div>
          )}
        </div>

      </div>
    </>
  );
}
