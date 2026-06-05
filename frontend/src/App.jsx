import React, { Fragment, useEffect, useRef, useState } from "react";
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

// ── Error boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(err, info) { console.error("Render error:", err, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 480, margin: "80px auto", padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 24 }}>
            An unexpected error occurred. Please refresh the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ background: "#2563EB", border: "none", borderRadius: 8, color: "#fff", fontFamily: "'Roboto',sans-serif", fontWeight: 700, fontSize: 14, padding: "10px 24px", cursor: "pointer" }}
          >
            Refresh page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
        borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
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

function RightTab({ label, active, onClick, dot }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "relative", background: "none", border: "none",
        borderBottom: `2px solid ${active ? "#2563EB" : "transparent"}`,
        color: active ? "#111827" : "#9CA3AF",
        padding: "13px 22px 12px", fontSize: 13,
        fontWeight: active ? 700 : 500, cursor: "pointer",
        fontFamily: "'Roboto',sans-serif", letterSpacing: "0.02em",
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
  const timerRef = useRef();
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1800);
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

// ── Apply edit to resume ───────────────────────────────────────────────────────
function applyEditToResume(resume, edit) {
  const norm    = (s) => (s || "").trim().toLowerCase();
  const matches = (a, b) => {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    return na.includes(nb.slice(0, 70)) || nb.includes(na.slice(0, 70));
  };
  const clone = structuredClone(resume);

  if (edit.type === "ADD") {
    if (!edit.target) return null; // no target = copy-only (backward compatible)
    const { section, name } = edit.target;
    if (section === "experience") {
      const entry = clone.experience.find(
        (e) => matches(e.company, name) || matches(e.role, name)
      );
      if (!entry) return null;
      // Already-applied check: same bullet already present? No-op success.
      if (entry.points.some((p) => matches(p, edit.statement))) return resume;
      entry.points.push(edit.statement);
      return clone;
    }
    if (section === "projects") {
      const entry = clone.projects.find((p) => matches(p.name, name));
      if (!entry) return null;
      if (entry.points.some((pt) => matches(pt, edit.statement))) return resume;
      entry.points.push(edit.statement);
      return clone;
    }
    return null;
  }

  // Plain-text resume renders skills as one row per category:
  //   "Category Name: item1, item2, item3"
  // The AI may suggest EDIT/DELETE against these rows. Parse them back so we
  // can mutate the structured skills[] array.
  const parseSkillRow = (s) => {
    if (!s) return null;
    const ci = s.indexOf(":");
    if (ci === -1) return null;
    const category = s.substring(0, ci).trim();
    const items = s.substring(ci + 1).split(",").map((x) => x.trim()).filter(Boolean);
    if (!category || items.length === 0) return null;
    return { category, items };
  };

  if (edit.type === "EDIT") {
    for (const e of clone.experience) {
      const i = e.points.findIndex((p) => matches(p, edit.from));
      if (i !== -1) { e.points[i] = edit.to; return clone; }
    }
    for (const p of clone.projects) {
      const i = p.points.findIndex((pt) => matches(pt, edit.from));
      if (i !== -1) { p.points[i] = edit.to; return clone; }
    }
    // Skill-row edit: "Category: a, b, c" → "Category: a, b, c, d"
    const fromSkill = parseSkillRow(edit.from);
    const toSkill   = parseSkillRow(edit.to);
    if (fromSkill && toSkill) {
      const idx = clone.skills.findIndex((s) => matches(s.category, fromSkill.category));
      if (idx !== -1) {
        clone.skills[idx] = {
          category: toSkill.category || clone.skills[idx].category,
          items:    toSkill.items,
        };
        return clone;
      }
    }
    // "from" not found — check whether the TO text is already in the resume
    // (edit was applied in a prior session, or this analysis is from History
    // and the resume has been edited since). If so, treat as no-op success.
    for (const e of resume.experience) {
      if (e.points.some((p) => matches(p, edit.to))) return resume;
    }
    for (const p of resume.projects) {
      if (p.points.some((pt) => matches(pt, edit.to))) return resume;
    }
    if (toSkill) {
      const idx = resume.skills.findIndex((s) => matches(s.category, toSkill.category));
      if (idx !== -1) {
        const curr = (resume.skills[idx].items || []).map((x) => x.toLowerCase()).sort().join("|");
        const want = toSkill.items.map((x) => x.toLowerCase()).sort().join("|");
        if (curr === want) return resume;
      }
    }
    return null;
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
    // Skill-row delete: "Category: a, b" → remove the whole category from skills[]
    const delSkill = parseSkillRow(edit.statement);
    if (delSkill) {
      const idx = clone.skills.findIndex((s) => matches(s.category, delSkill.category));
      if (idx !== -1) { clone.skills.splice(idx, 1); return clone; }
    }
    // Statement isn't anywhere in the resume — already deleted. No-op success.
    return resume;
  }

  return null;
}

// ── Analysis UI components ────────────────────────────────────────────────────

// Backward-compat shim: old analyses (matchScore-era) get massaged into the new
// optimization-first shape so the new UI renders them without crashing.
function normalizeAnalysis(a) {
  if (!a || a.fitLevel) return a; // already in new shape (or null)
  const labelMap = { "Strong Fit": "Strong Fit", "Medium Fit": "Moderate Fit", "Weak Fit": "Weak Fit" };
  const fitFromScore = (s) =>
    Number.isFinite(s) ? (s >= 75 ? "Strong Fit" : s >= 50 ? "Moderate Fit" : "Weak Fit") : "";
  const priorityFromImpact = (i) =>
    Number.isFinite(i) ? (i >= 7 ? "HIGH" : i >= 4 ? "MEDIUM" : "LOW") : "MEDIUM";
  return {
    ...a,
    fitLevel:            labelMap[a.matchLabel] || fitFromScore(a.matchScore),
    summary:             a.summary || a.matchReasoning || "",
    matchedRequirements: a.matchedRequirements || a.skillsToHighlight || [],
    optimizableGaps:     a.optimizableGaps || a.keywordGaps || [],
    nonOptimizableGaps:  a.nonOptimizableGaps || [],
    edits: (a.edits || []).map((e) => ({
      ...e,
      priority: e.priority || priorityFromImpact(e.impactScore),
    })),
  };
}

function fitLevelStyle(level) {
  if (level === "Strong Fit")   return { color: "#059669", bg: "#ECFDF5", border: "#6EE7B7" };
  if (level === "Moderate Fit") return { color: "#D97706", bg: "#FEF3C7", border: "#FDE68A" };
  if (level === "Weak Fit")     return { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" };
  return                          { color: "#6B7280", bg: "#F3F4F6", border: "#E5E7EB" };
}

function FitBadge({ level }) {
  const s = fitLevelStyle(level);
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
      color: s.color, background: s.bg, padding: "5px 12px", borderRadius: 20,
      border: `1px solid ${s.border}`, fontFamily: "'Roboto',sans-serif",
    }}>{level || "Unknown Fit"}</span>
  );
}

function priorityStyle(p) {
  if (p === "HIGH")   return { color: "#B91C1C", bg: "#FEE2E2", border: "#FCA5A5", label: "High Priority" };
  if (p === "MEDIUM") return { color: "#B45309", bg: "#FEF3C7", border: "#FCD34D", label: "Medium Priority" };
  return                { color: "#0369A1", bg: "#E0F2FE", border: "#7DD3FC", label: "Low Priority" };
}

function EditCard({ edit, onApply, applied, editorAvailable = true }) {
  const [applyFailed, setApplyFailed] = useState(false);
  const failTimerRef = useRef();
  useEffect(() => () => clearTimeout(failTimerRef.current), []);
  const C = {
    ADD:    { bg: "#ECFDF5", border: "#10B981", badge: "#059669" },
    EDIT:   { bg: "#EFF6FF", border: "#3B82F6", badge: "#2563EB" },
    DELETE: { bg: "#FEF2F2", border: "#EF4444", badge: "#DC2626" },
  };
  const c        = C[edit.type] || C.ADD;
  const copyText = edit.type === "EDIT" ? edit.to : edit.statement;
  const canApply = editorAvailable && (
    edit.type === "EDIT" ||
    edit.type === "DELETE" ||
    (edit.type === "ADD" && !!edit.target)
  );

  const handleApply = () => {
    const ok = onApply();
    if (!ok) {
      setApplyFailed(true);
      clearTimeout(failTimerRef.current);
      failTimerRef.current = setTimeout(() => setApplyFailed(false), 2500);
    }
  };

  return (
    <div style={{ background: c.bg, border: "1px solid #E5E7EB", borderLeft: `3px solid ${c.border}`, borderRadius: 10, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: c.badge, background: `${c.badge}1a`, padding: "3px 9px", borderRadius: 4, fontFamily: "'Space Mono',monospace", flexShrink: 0 }}>
            {edit.type}
          </span>
          {edit.priority && (() => {
            const p = priorityStyle(edit.priority);
            return (
              <span
                title={edit.reason || ""}
                style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: p.color, background: p.bg, border: `1px solid ${p.border}`, padding: "2px 8px", borderRadius: 4, fontFamily: "'Roboto',sans-serif", flexShrink: 0 }}
              >
                {p.label}
              </span>
            );
          })()}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {canApply && !applied && !applyFailed && (
            <button
              onClick={handleApply}
              style={{
                background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#2563EB",
                borderRadius: 5, padding: "5px 13px", fontSize: 12, fontWeight: 700,
                cursor: "pointer", fontFamily: "'Roboto',sans-serif",
              }}
            >
              Apply →
            </button>
          )}
          {applied     && <span style={{ fontSize: 12, color: "#059669", fontWeight: 700 }}>✓ Applied</span>}
          {applyFailed && <span style={{ fontSize: 12, color: "#DC2626" }}>Not found — copy &amp; paste</span>}
          <CopyBtn text={copyText} />
        </div>
      </div>

      {edit.type === "ADD" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, margin: 0 }}>{edit.statement}</p>
          {edit.target && (
            <span style={{ fontSize: 11, color: "#059669", fontFamily: "'Space Mono',monospace", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ opacity: 0.5 }}>→</span>
              {edit.target.name}
              <span style={{ opacity: 0.5, fontFamily: "'Roboto',sans-serif", fontStyle: "italic" }}>
                ({edit.target.section})
              </span>
            </span>
          )}
        </div>
      )}
      {edit.type === "EDIT" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <p style={{ fontSize: 12, color: "#9CA3AF", lineHeight: 1.5, margin: 0, textDecoration: "line-through", fontStyle: "italic" }}>{edit.from}</p>
          <div style={{ display: "flex", gap: 5, alignItems: "flex-start" }}>
            <span style={{ color: "#3B82F6", fontSize: 14, marginTop: 1, flexShrink: 0 }}>→</span>
            <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, margin: 0 }}>{edit.to}</p>
          </div>
        </div>
      )}
      {edit.type === "DELETE" && <p style={{ fontSize: 13, color: "#9CA3AF", lineHeight: 1.6, margin: 0, textDecoration: "line-through" }}>{edit.statement}</p>}

      {edit.reason && (
        <p style={{ fontSize: 11, color: "#6B7280", margin: 0, fontStyle: "italic", lineHeight: 1.5 }}>
          Why: {edit.reason}
        </p>
      )}
    </div>
  );
}

function AnalysisInsights({ analysis: rawAnalysis, onReset, onApply, onApplyAll, onGoPreview, appliedEdits = new Set(), editorAvailable = true }) {
  const analysis = normalizeAnalysis(rawAnalysis);
  const unappliedApplicableCount = (analysis.edits || []).reduce((acc, e, i) => {
    if (appliedEdits.has(i)) return acc;
    const ok = e.type === "EDIT" || e.type === "DELETE" || (e.type === "ADD" && e.target);
    return ok ? acc + 1 : acc;
  }, 0);
  const hasApplied = appliedEdits.size > 0;

  const renderChips = (items, palette) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((it, i) => (
        <span key={i} style={{ fontSize: 11, fontFamily: "'Space Mono',monospace", color: palette.color, background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 3, padding: "3px 7px" }}>{it}</span>
      ))}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 12, color: "#6B7280", margin: 0 }}>{analysis.jobTitle} · {analysis.company}</p>
          <FitBadge level={analysis.fitLevel} />
        </div>
        <GhostBtn onClick={onReset} style={{ fontSize: 13, padding: "6px 14px", flexShrink: 0 }}>← New</GhostBtn>
      </div>

      {editorAvailable && hasApplied && onGoPreview && (
        <div style={{ background: "#ECFDF5", border: "1px solid #6EE7B7", borderRadius: 10, padding: "11px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <p style={{ fontSize: 12, color: "#065F46", margin: 0, lineHeight: 1.5, fontWeight: 600 }}>
            {appliedEdits.size} {appliedEdits.size === 1 ? "edit" : "edits"} applied. Ready to preview your resume?
          </p>
          <PrimaryBtn onClick={onGoPreview} style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}>
            Preview Resume →
          </PrimaryBtn>
        </div>
      )}

      {analysis.summary && (
        <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.65, margin: 0 }}>{analysis.summary}</p>
      )}

      {analysis.matchedRequirements?.length > 0 && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#059669", marginBottom: 6 }}>
            ✓ Already Covered
          </p>
          {renderChips(analysis.matchedRequirements, { color: "#065F46", bg: "#ECFDF5", border: "#6EE7B7" })}
        </div>
      )}

      {analysis.optimizableGaps?.length > 0 && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#B45309", marginBottom: 6 }}>
            ✎ Can Be Improved
          </p>
          {renderChips(analysis.optimizableGaps, { color: "#92400E", bg: "#FEF3C7", border: "#FDE68A" })}
        </div>
      )}

      {analysis.nonOptimizableGaps?.length > 0 && (
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280", marginBottom: 6 }}>
            ✗ Not Present in Resume
          </p>
          {renderChips(analysis.nonOptimizableGaps, { color: "#4B5563", bg: "#F3F4F6", border: "#D1D5DB" })}
          <p style={{ fontSize: 11, color: "#9CA3AF", marginTop: 6, lineHeight: 1.5, fontStyle: "italic" }}>
            These can't honestly be added through editing — the resume lacks the underlying evidence.
          </p>
        </div>
      )}

      {analysis.edits?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280", margin: 0 }}>
              {analysis.edits.length} suggested {analysis.edits.length === 1 ? "change" : "changes"}
              {analysis.edits.some((e) => e.type === "ADD" && !e.target) && (
                <span style={{ color: "#9CA3AF", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  {" "}— some ADD cards are copy-only
                </span>
              )}
            </p>
            {editorAvailable && onApplyAll && unappliedApplicableCount > 0 && (
              <button
                onClick={onApplyAll}
                style={{
                  background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#2563EB",
                  borderRadius: 5, padding: "5px 12px", fontSize: 11, fontWeight: 700,
                  cursor: "pointer", fontFamily: "'Roboto',sans-serif", whiteSpace: "nowrap",
                }}
              >
                Apply all ({unappliedApplicableCount}) →
              </button>
            )}
          </div>
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
      <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>{analysis.jobTitle} · {analysis.company}</p>

      {analysis.linkedinMessage && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid #E5E7EB", background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>💼</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#2563EB" }}>LinkedIn Message</span>
            </div>
            <CopyBtn text={analysis.linkedinMessage} />
          </div>
          <div style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 12, color: "#6B7280", marginBottom: 10 }}>Under 300 chars = higher reply rate.</p>
            <div style={{ background: "#F8FAFC", borderRadius: 8, padding: 12, border: "1px solid #E5E7EB" }}>
              <p style={{ fontSize: 13, color: "#111827", lineHeight: 1.75, margin: 0 }}>{analysis.linkedinMessage}</p>
            </div>
          </div>
        </div>
      )}

      {analysis.coldEmail && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid #E5E7EB", background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>📧</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C3AED" }}>Cold Email</span>
            </div>
            <CopyBtn text={`Subject: ${analysis.coldEmail.subject}\n\n${analysis.coldEmail.body}`} />
          </div>
          <div style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 12, color: "#6B7280", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ background: "#EDE9FE", color: "#7C3AED", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>
                [Recipient Name]
              </span>
              <span>→ replace with the actual person's name before sending.</span>
            </p>
            <div style={{ background: "#F8FAFC", borderRadius: 8, padding: 14, border: "1px solid #E5E7EB" }}>
              <p style={{ fontSize: 11, color: "#7C3AED", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                Subject: {analysis.coldEmail.subject}
              </p>
              <div style={{ height: 1, background: "#E5E7EB", marginBottom: 10 }} />
              <p style={{ fontSize: 13, color: "#111827", lineHeight: 1.8, margin: 0, whiteSpace: "pre-line" }}>{analysis.coldEmail.body}</p>
            </div>
          </div>
        </div>
      )}

      {analysis.coverLetter && (
        <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid #E5E7EB", background: "#FEF3C7", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>📝</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#B45309" }}>Cover Letter</span>
            </div>
            <CopyBtn text={`Subject: ${analysis.coverLetter.subject}\n\n${analysis.coverLetter.body}`} />
          </div>
          <div style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 12, color: "#6B7280", marginBottom: 10, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
              <span style={{ background: "#FDE68A", color: "#B45309", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>
                [Hiring Manager]
              </span>
              <span>and</span>
              <span style={{ background: "#FDE68A", color: "#B45309", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>
                [Your Name]
              </span>
              <span>→ replace before sending.</span>
            </p>
            <div style={{ background: "#F8FAFC", borderRadius: 8, padding: 14, border: "1px solid #E5E7EB" }}>
              <p style={{ fontSize: 11, color: "#B45309", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                Subject: {analysis.coverLetter.subject}
              </p>
              <div style={{ height: 1, background: "#E5E7EB", marginBottom: 10 }} />
              <p style={{ fontSize: 13, color: "#111827", lineHeight: 1.8, margin: 0, whiteSpace: "pre-line" }}>{analysis.coverLetter.body}</p>
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

// ── BuyCreditsModal ───────────────────────────────────────────────────────────
function BuyCreditsModal({ auth, onClose }) {
  const [loadingPkg, setLoadingPkg]   = useState(null);
  const [currencyData, setCurrencyData] = useState(null);
  const [checkoutError, setCheckoutError] = useState("");

  useEffect(() => {
    api.getCurrency()
      .then(setCurrencyData)
      .catch(() => setCurrencyData({
        currency: "usd",
        packages: [
          { key: "starter", credits: 5,  price: "$2.50",  per_analysis: "$0.50/analysis" },
          { key: "pro",     credits: 15, price: "$6.00",  per_analysis: "$0.40/analysis" },
          { key: "power",   credits: 40, price: "$14.00", per_analysis: "$0.35/analysis" },
        ],
      }));
  }, []);

  const LABELS = { starter: "Starter", pro: "Pro", power: "Power" };
  const packages = (currencyData?.packages ?? []).map((p) => ({
    ...p,
    label: LABELS[p.key] ?? p.key,
    best: p.key === "power",
  }));

  const handleBuy = async (pkg) => {
    setCheckoutError("");
    setLoadingPkg(pkg);
    try {
      const data = await api.checkout(pkg, auth.token);
      window.location.href = data.url;
    } catch (err) {
      console.error("Checkout error:", err.message);
      setCheckoutError(err.message || "Couldn't start checkout. Please try again.");
      setLoadingPkg(null);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 28, maxWidth: 580, width: "100%", display: "flex", flexDirection: "column", gap: 22, boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 3 }}>Buy Credits</h3>
            <p style={{ fontSize: 13, color: "#6B7280", margin: 0 }}>Each analysis costs 1 credit.</p>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 22, lineHeight: 1, padding: "2px 6px" }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {!currencyData ? (
            [1, 2, 3].map((n) => (
              <div key={n} style={{ border: "1px solid #E5E7EB", borderRadius: 12, padding: "18px 14px", height: 160, background: "#F9FAFB", animation: "pulse 1.2s ease-in-out infinite" }} />
            ))
          ) : packages.map((pkg) => {
            const isLoading = loadingPkg === pkg.key;
            return (
              <div
                key={pkg.key}
                style={{
                  border: pkg.best ? "2px solid #2563EB" : "1px solid #E5E7EB",
                  borderRadius: 12, padding: "18px 14px",
                  display: "flex", flexDirection: "column", gap: 8,
                  position: "relative", background: pkg.best ? "#EFF6FF" : "#FFFFFF",
                }}
              >
                {pkg.best && (
                  <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#2563EB", color: "#FFFFFF", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "2px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>
                    Best Value
                  </div>
                )}
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{pkg.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#2563EB", fontFamily: "'Space Mono',monospace" }}>{pkg.credits}</div>
                <div style={{ fontSize: 11, color: "#6B7280" }}>credits</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>{pkg.price}</div>
                <div style={{ fontSize: 11, color: "#9CA3AF" }}>{pkg.per_analysis}</div>
                <button
                  onClick={() => !loadingPkg && handleBuy(pkg.key)}
                  disabled={!!loadingPkg}
                  style={{
                    marginTop: 6,
                    background: pkg.best ? "#2563EB" : "#EFF6FF",
                    border: pkg.best ? "none" : "1px solid #BFDBFE",
                    color: pkg.best ? "#FFFFFF" : "#2563EB",
                    borderRadius: 8, padding: "9px 0", fontSize: 12, fontWeight: 700,
                    cursor: loadingPkg ? "not-allowed" : "pointer",
                    fontFamily: "'Roboto',sans-serif",
                    opacity: loadingPkg && !isLoading ? 0.5 : 1,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}
                >
                  {isLoading ? (
                    <>
                      <span style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid transparent", borderTop: `2px solid ${pkg.best ? "#FFFFFF" : "#2563EB"}`, animation: "spin 0.8s linear infinite", display: "inline-block" }} />
                      Loading…
                    </>
                  ) : pkg.best ? "Buy →  ✓" : "Buy →"}
                </button>
              </div>
            );
          })}
        </div>

        {checkoutError && (
          <p style={{ fontSize: 12, color: "#DC2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", margin: 0, textAlign: "center" }}>
            {checkoutError}
          </p>
        )}

        <p style={{ fontSize: 11, color: "#9CA3AF", textAlign: "center", margin: 0 }}>
          Secure payment via Stripe. Credits never expire.
        </p>
      </div>
    </div>
  );
}

// ── CreditsBadge ──────────────────────────────────────────────────────────────
function CreditsBadge({ balance, onOpenModal }) {
  if (balance === null) return null;

  const isEmpty = balance === 0;
  const isLow   = balance === 1;
  const color   = isEmpty ? "#DC2626" : isLow ? "#D97706" : "#374151";
  const bg      = isEmpty ? "#FEF2F2" : isLow ? "#FEF3C7" : "#F3F4F6";
  const border  = isEmpty ? "#FECACA" : isLow ? "#FDE68A" : "#E5E7EB";

  return (
    <button
      onClick={onOpenModal}
      title={isLow ? "1 credit left" : undefined}
      style={{
        background: bg, border: `1px solid ${border}`, borderRadius: 20,
        padding: "4px 12px", fontSize: 12, fontWeight: 600, color,
        cursor: "pointer", fontFamily: "'Roboto',sans-serif",
        display: "flex", alignItems: "center", gap: 5,
      }}
    >
      ⚡ {isEmpty ? "Buy credits" : `${balance} credit${balance === 1 ? "" : "s"}`}
    </button>
  );
}

// ── Credits success / cancel pages ────────────────────────────────────────────
function CreditsSuccessPage({ onGoEditor, onCreditsFetched, auth }) {
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    if (auth?.token) {
      api.getCredits(auth.token)
        .then((data) => { if (onCreditsFetched) onCreditsFetched(data.balance); })
        .catch(() => {});
    }
    const interval = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) { clearInterval(interval); onGoEditor(); return 0; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "100px 20px", textAlign: "center" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#ECFDF5", border: "2px solid #6EE7B7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 20px" }}>
        ✓
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#111827", marginBottom: 8 }}>Credits added!</h1>
      <p style={{ color: "#6B7280", fontSize: 15, lineHeight: 1.6, marginBottom: 24 }}>Your balance has been updated.</p>
      <p style={{ color: "#9CA3AF", fontSize: 13 }}>Redirecting in {countdown}s…</p>
    </div>
  );
}

function CreditsCancelPage({ onGoEditor }) {
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "100px 20px", textAlign: "center" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F3F4F6", border: "2px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 20px" }}>
        ✕
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#111827", marginBottom: 8 }}>Payment cancelled</h1>
      <p style={{ color: "#6B7280", fontSize: 15, marginBottom: 28 }}>No charges were made.</p>
      <PrimaryBtn onClick={onGoEditor} style={{ padding: "10px 28px" }}>Back to Editor</PrimaryBtn>
    </div>
  );
}

// ── JobInputForm ──────────────────────────────────────────────────────────────
function JobInputForm({ onAnalyze, loading }) {
  const [jobInput, setJobInput] = useState("");
  const inputStyle = {
    width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10,
    color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px",
    outline: "none", boxSizing: "border-box",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280" }}>Job Description</span>
      <textarea style={{ ...inputStyle, minHeight: 110, resize: "vertical" }} placeholder="Paste the full job description here…" value={jobInput} onChange={(e) => setJobInput(e.target.value)} />
      <p style={{ fontSize: 11, color: "#9CA3AF", margin: 0, lineHeight: 1.5 }}>For best results, paste the full job description.</p>
      <PrimaryBtn
        onClick={() => onAnalyze(jobInput.trim(), "paste")}
        disabled={loading || !jobInput.trim()}
        style={{ width: "100%", padding: "12px" }}
      >
        {loading ? "Analyzing…" : "Analyze →"}
      </PrimaryBtn>
    </div>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────
function HomePage({ onGuest, onLogin, auth, onGoEditor, onPricing }) {
  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 20px 100px" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ display: "inline-block", fontFamily: "'Space Mono',monospace", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "#2563EB", background: "#EFF6FF", border: "1px solid #BFDBFE", padding: "4px 14px", borderRadius: 20, marginBottom: 18 }}>
          AI Job Application Co-Pilot
        </div>
        <h1 style={{ fontSize: "clamp(28px,4.5vw,44px)", fontWeight: 700, lineHeight: 1.15, marginBottom: 14, letterSpacing: "-0.02em", color: "#111827" }}>
          Land the job,<br /><span style={{ color: "#059669" }}>not just the interview.</span>
        </h1>
        <p style={{ color: "#6B7280", fontSize: 15, lineHeight: 1.7, maxWidth: 440, margin: "0 auto 20px" }}>
          Instant resume analysis, keyword gap detection, tailored edits, and outreach messages — all from one paste.
        </p>
        <button
          onClick={onPricing}
          style={{ background: "none", border: "none", color: "#2563EB", fontSize: 13, cursor: "pointer", fontFamily: "'Roboto',sans-serif", padding: 0, textDecoration: "underline", textDecorationColor: "#BFDBFE" }}
        >
          View pricing →
        </button>
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

// ── Guest page ────────────────────────────────────────────────────────────────
function GuestPage({ onBack, onSignUp }) {
  const [step, setStep]                     = useState("input");
  const [resumeMode, setResumeMode]         = useState("upload");
  const [resumeFile, setResumeFile]         = useState(null);
  const [resumeText, setResumeText]         = useState("");
  const [analysis, setAnalysis]             = useState(null);
  const [guestTab, setGuestTab]             = useState("analysis");
  const [error, setError]                   = useState("");
  const [guestLimitReached, setGuestLimitReached] = useState(false);
  const [guestLimit, setGuestLimit]               = useState(null);
  const fileRef = useRef();

  // Warn guest before browser-level navigation (close, refresh, back) when an
  // unsaved analysis result is on screen — no account = no way to recover it.
  useEffect(() => {
    if (!analysis) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [analysis]);

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
    setError(""); setGuestLimitReached(false);
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
    } catch (err) {
      if (err.code === "GUEST_LIMIT" || err.message?.includes("Guest limit")) {
        setGuestLimitReached(true);
        if (err.limit) setGuestLimit(err.limit);
      } else {
        setError("Analysis failed: " + err.message);
      }
      setStep("input");
    }
  };

  const resetToInput = () => { setStep("input"); setAnalysis(null); };

  if (step === "loading") return <div style={{ maxWidth: 480, margin: "0 auto", padding: "80px 20px" }}><Spinner label="Analyzing your application…" /></div>;

  if (step === "results" && analysis) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "36px 20px 60px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <button onClick={resetToInput} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", fontFamily: "'Roboto',sans-serif", marginBottom: 8, padding: 0 }}>← New analysis</button>
            <p style={{ fontSize: 13, color: "#6B7280", marginBottom: 6 }}>{analysis.jobTitle} · {analysis.company}</p>
            <FitBadge level={normalizeAnalysis(analysis).fitLevel} />
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

      {/* Guest limit reached banner */}
      {guestLimitReached && (
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 10, padding: "14px 16px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 13, color: "#92400E", fontWeight: 600, margin: 0 }}>
            You've used your {guestLimit ?? "free"} {guestLimit ? "free analyses" : "guest analyses"}.
          </p>
          <p style={{ fontSize: 12, color: "#78350F", margin: 0, lineHeight: 1.5 }}>
            Create a free account to keep going.
          </p>
          <PrimaryBtn onClick={onSignUp} style={{ alignSelf: "flex-start", padding: "8px 18px", fontSize: 13 }}>
            Sign Up Free →
          </PrimaryBtn>
        </div>
      )}

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

// ── Auth page ─────────────────────────────────────────────────────────────────
function AuthPage({ mode, onAuth, onToggle, onBack, onForgot }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const inputStyle = { width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px", outline: "none", boxSizing: "border-box" };
  const submit = async () => {
    setError("");
    if (!email || !password) { setError("Email and password required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError("Please enter a valid email address."); return; }
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
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "At least 6 characters" : "Your password"} style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <p style={{ color: "#DC2626", fontSize: 13, background: "#FEF2F2", padding: "10px 16px", borderRadius: 8, border: "1px solid #FECACA", margin: 0 }}>{error}</p>}
        <PrimaryBtn onClick={submit} disabled={loading} style={{ width: "100%" }}>{loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}</PrimaryBtn>
        {mode === "login" && (
          <p style={{ fontSize: 13, color: "#6B7280", textAlign: "center", marginTop: -4 }}>
            <button onClick={onForgot} style={{ background: "none", border: "none", color: "#2563EB", cursor: "pointer", fontSize: 13, fontFamily: "'Roboto',sans-serif", padding: 0 }}>
              Forgot password?
            </button>
          </p>
        )}
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

// ── Forgot Password page ──────────────────────────────────────────────────────
function ForgotPasswordPage({ onBack, onGoLogin }) {
  const [email, setEmail]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [sent, setSent]       = useState(false);
  const inputStyle = { width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px", outline: "none", boxSizing: "border-box" };

  const submit = async () => {
    setError("");
    if (!email) { setError("Email is required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError("Please enter a valid email address."); return; }
    setLoading(true);
    try { await api.forgotPassword(email); setSent(true); }
    catch (err) { setError(err.message || "Could not send reset email."); }
    finally { setLoading(false); }
  };

  if (sent) {
    return (
      <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px" }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Check your inbox</h1>
        <p style={{ color: "#6B7280", fontSize: 14, lineHeight: 1.7, marginBottom: 22 }}>
          If an account exists for <strong>{email}</strong>, we've sent a password reset link. The link expires in 15 minutes.
        </p>
        <GhostBtn onClick={onGoLogin} style={{ fontSize: 13 }}>← Back to login</GhostBtn>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 24, fontFamily: "'Roboto',sans-serif" }}>← Back</button>
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6, color: "#111827" }}>Forgot password?</h1>
      <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 28 }}>Enter your email and we'll send you a reset link.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <p style={{ color: "#DC2626", fontSize: 13, background: "#FEF2F2", padding: "10px 16px", borderRadius: 8, border: "1px solid #FECACA", margin: 0 }}>{error}</p>}
        <PrimaryBtn onClick={submit} disabled={loading} style={{ width: "100%" }}>{loading ? "Sending…" : "Send reset link"}</PrimaryBtn>
        <p style={{ fontSize: 13, color: "#6B7280", textAlign: "center" }}>
          Remembered it?{" "}
          <button onClick={onGoLogin} style={{ background: "none", border: "none", color: "#2563EB", cursor: "pointer", fontSize: 13, fontFamily: "'Roboto',sans-serif", padding: 0 }}>Sign in</button>
        </p>
      </div>
    </div>
  );
}

// ── Reset Password page ──────────────────────────────────────────────────────
function ResetPasswordPage({ onGoLogin }) {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [password, setPassword]   = useState("");
  const [confirm, setConfirm]     = useState("");
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [success, setSuccess]     = useState(false);
  const inputStyle = { width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px", outline: "none", boxSizing: "border-box" };

  const submit = async () => {
    setError("");
    if (!token) { setError("Missing reset token. Please use the link from your email."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setLoading(true);
    try { await api.resetPassword(token, password); setSuccess(true); }
    catch (err) { setError(err.message || "Reset failed."); }
    finally { setLoading(false); }
  };

  if (success) {
    return (
      <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#ECFDF5", border: "2px solid #6EE7B7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 18px" }}>✓</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: "#111827" }}>Password updated</h1>
        <p style={{ color: "#6B7280", fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>You can now sign in with your new password.</p>
        <PrimaryBtn onClick={onGoLogin}>Sign in →</PrimaryBtn>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px" }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6, color: "#111827" }}>Set a new password</h1>
      <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 28 }}>Choose a password you haven't used before.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>New password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280", display: "block", marginBottom: 6 }}>Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat your password" style={inputStyle} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        {error && <p style={{ color: "#DC2626", fontSize: 13, background: "#FEF2F2", padding: "10px 16px", borderRadius: 8, border: "1px solid #FECACA", margin: 0 }}>{error}</p>}
        <PrimaryBtn onClick={submit} disabled={loading} style={{ width: "100%" }}>{loading ? "Updating…" : "Update password"}</PrimaryBtn>
      </div>
    </div>
  );
}

// ── Account page (delete account) ─────────────────────────────────────────────
function AccountPage({ auth, onBack, onDeleted }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting]       = useState(false);
  const [error, setError]             = useState("");

  const email = auth.user?.email || "";
  const canDelete = confirmText.trim().toLowerCase() === email.toLowerCase();

  const handleDelete = async () => {
    if (!canDelete) return;
    setError(""); setDeleting(true);
    try { await api.deleteAccount(auth.token); onDeleted(); }
    catch (err) { setError(err.message || "Could not delete account."); setDeleting(false); }
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px 100px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 24, fontFamily: "'Roboto',sans-serif" }}>← Back</button>
      <h1 style={{ fontSize: 26, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Account</h1>
      <p style={{ color: "#6B7280", fontSize: 14, marginBottom: 28 }}>Manage your Resume CoPilot account.</p>

      <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, padding: 22, marginBottom: 24 }}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280", marginBottom: 6 }}>Email</p>
        <p style={{ fontSize: 14, color: "#111827", margin: 0, wordBreak: "break-all" }}>{email}</p>
      </div>

      <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: "#991B1B", marginBottom: 4 }}>Danger zone</h2>
          <p style={{ fontSize: 13, color: "#7F1D1D", margin: 0, lineHeight: 1.6 }}>
            Deleting your account permanently removes your resumes, analysis history, and credit balance. <strong>This cannot be undone.</strong>
          </p>
        </div>
        {!showConfirm ? (
          <button
            onClick={() => setShowConfirm(true)}
            style={{ alignSelf: "flex-start", background: "#FFFFFF", border: "1px solid #FCA5A5", color: "#DC2626", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Roboto',sans-serif" }}
          >
            Delete my account
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ fontSize: 12, color: "#7F1D1D", margin: 0 }}>
              To confirm, type your email <strong>{email}</strong> below.
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={email}
              style={{ width: "100%", background: "#FFFFFF", border: "1px solid #FCA5A5", borderRadius: 8, color: "#111827", fontSize: 14, padding: "10px 14px", outline: "none", boxSizing: "border-box", fontFamily: "'Roboto',sans-serif" }}
            />
            {error && <p style={{ fontSize: 12, color: "#991B1B", margin: 0 }}>{error}</p>}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setShowConfirm(false); setConfirmText(""); setError(""); }}
                disabled={deleting}
                style={{ background: "transparent", border: "1px solid #E5E7EB", color: "#6B7280", borderRadius: 8, padding: "9px 18px", fontSize: 13, cursor: "pointer", fontFamily: "'Roboto',sans-serif" }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!canDelete || deleting}
                style={{
                  background: canDelete ? "#DC2626" : "#FCA5A5",
                  border: "none", color: "#FFFFFF", borderRadius: 8, padding: "9px 18px",
                  fontSize: 13, fontWeight: 700, cursor: canDelete && !deleting ? "pointer" : "not-allowed",
                  fontFamily: "'Roboto',sans-serif", opacity: deleting ? 0.7 : 1,
                }}
              >
                {deleting ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Confirm modal ─────────────────────────────────────────────────────────────
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

// ── Stepper ───────────────────────────────────────────────────────────────────
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
              width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, fontFamily: "'Space Mono',monospace",
              background: i < curr ? "#DBEAFE" : i === curr ? "#2563EB" : "transparent",
              border: `1.5px solid ${i <= curr ? "#2563EB" : "#D1D5DB"}`,
              color: i < curr ? "#2563EB" : i === curr ? "#FFFFFF" : "#9CA3AF",
            }}>
              {i < curr ? "✓" : i + 1}
            </div>
            <span style={{
              fontSize: 11, fontWeight: i === curr ? 700 : 400,
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

// ── Import landing ────────────────────────────────────────────────────────────
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
function ExportModal({ resume, onExport, onCancel, exporting, error }) {
  const defaultName = resume.basics?.name
    ? resume.basics.name.trim().replace(/\s+/g, "_") + "_Resume"
    : "Resume";
  const [filename, setFilename] = useState(defaultName);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: 28, maxWidth: 400, width: "100%", display: "flex", flexDirection: "column", gap: 20, boxShadow: "0 20px 60px rgba(0,0,0,0.12)" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Export Resume</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280" }}>File Name</label>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            style={{ background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 8, color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "11px 14px", outline: "none", width: "100%", boxSizing: "border-box" }}
          />
          <span style={{ fontSize: 11, color: "#6B7280" }}>
            Saves as <strong style={{ color: "#374151" }}>{(filename || "Resume").trim()}.docx</strong>
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280" }}>Format</label>
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

        {error && (
          <p style={{ fontSize: 12, color: "#DC2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", margin: 0 }}>
            {error}
          </p>
        )}

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

// ── Stage nav bar ─────────────────────────────────────────────────────────────
const NAV = {
  height: 48,
  style: {
    display: "grid", gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center", gap: 12,
    padding: "0 16px", borderBottom: "1px solid #E5E7EB",
    background: "#FFFFFF", flexShrink: 0,
  },
};

// ── History panel ─────────────────────────────────────────────────────────────
function HistoryPanel({ auth, onLoad }) {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  useEffect(() => {
    api.getAnalyses(auth.token)
      .then(({ analyses }) => setItems(analyses))
      .catch(() => setError("Failed to load history."))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    try {
      await api.deleteAnalysis(id, auth.token);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch { /* ignore */ }
  };

  if (loading) return <div style={{ padding: "20px 0" }}><Spinner /></div>;
  if (error)   return <p style={{ fontSize: 12, color: "#DC2626", padding: "12px 0" }}>{error}</p>;
  if (!items.length) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "20px 0", textAlign: "center" }}>
      <p style={{ fontSize: 13, color: "#9CA3AF" }}>No history yet.</p>
      <p style={{ fontSize: 12, color: "#D1D5DB" }}>Run your first analysis to see it here.</p>
    </div>
  );

  // Derive fitLevel for any row — new rows store it in match_label directly;
  // legacy rows may have "Medium Fit" or only a numeric match_score.
  const rowFitLevel = (item) => {
    if (item.match_label === "Strong Fit")   return "Strong Fit";
    if (item.match_label === "Moderate Fit") return "Moderate Fit";
    if (item.match_label === "Medium Fit")   return "Moderate Fit"; // legacy alias
    if (item.match_label === "Weak Fit")     return "Weak Fit";
    if (Number.isFinite(item.match_score) && item.match_score > 0) {
      return item.match_score >= 75 ? "Strong Fit" : item.match_score >= 50 ? "Moderate Fit" : "Weak Fit";
    }
    return "";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => (
        <div
          key={item.id}
          onClick={() => onLoad(item.result)}
          style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10, padding: "12px 14px", cursor: "pointer", transition: "border-color 0.15s" }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#93C5FD")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#E5E7EB")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: "#111827", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.job_title || "Unknown Role"}
              </p>
              <p style={{ fontSize: 12, color: "#6B7280", marginBottom: 3 }}>{item.company || "—"}</p>
              <p style={{ fontSize: 11, color: "#9CA3AF" }}>
                {new Date(item.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                {" · "}
                {new Date(item.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {(() => {
                const lvl = rowFitLevel(item);
                if (!lvl) return null;
                const s = fitLevelStyle(lvl);
                return (
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                    color: s.color, background: s.bg, padding: "3px 8px", borderRadius: 12,
                    border: `1px solid ${s.border}`, whiteSpace: "nowrap", fontFamily: "'Roboto',sans-serif",
                  }}>{lvl.replace(" Fit", "")}</span>
                );
              })()}
              <button
                onClick={(e) => handleDelete(e, item.id)}
                style={{ background: "none", border: "none", color: "#D1D5DB", cursor: "pointer", fontSize: 16, padding: "2px 4px", lineHeight: 1 }}
                title="Delete"
              >×</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Editor page — 3-stage flow ────────────────────────────────────────────────
function EditorPage({ auth, creditBalance, onOpenBuyModal, onAnalysisComplete }) {
  const [loadingResume, setLoadingResume]       = useState(true);
  const [stage, setStage]                       = useState("edit");
  const [showImportLanding, setShowImportLanding] = useState(false);
  const [resume, setResume]                     = useState(EMPTY_RESUME);
  const [resumeName, setResumeName]             = useState("My Resume");
  const [isImported, setIsImported]             = useState(false);
  const [saving, setSaving]                     = useState(false);
  const [exporting, setExporting]               = useState(false);
  const [saveMsg, setSaveMsg]                   = useState("");
  const [importing, setImporting]               = useState(false);
  const [importError, setImportError]           = useState("");
  const [pendingImport, setPendingImport]       = useState(null);
  const [leftTab, setLeftTab]                   = useState("analyze"); // "analyze" | "history"
  const [importSuccess, setImportSuccess]       = useState(false);
  const importSuccessTimer                      = useRef(null);
  const saveMsgTimerRef                         = useRef(null);
  const replaceFileRef                          = useRef();
  const editorScrollRef                         = useRef();

  // Clean up pending timers on unmount
  useEffect(() => () => {
    clearTimeout(importSuccessTimer.current);
    clearTimeout(saveMsgTimerRef.current);
    clearTimeout(copyPlainTextTimerRef.current);
  }, []);
  const [showExportModal, setShowExportModal]   = useState(false);
  const [exportError, setExportError]           = useState("");
  const [previewError, setPreviewError]         = useState("");
  const [copiedPlainText, setCopiedPlainText]   = useState(false);
  const copyPlainTextTimerRef                   = useRef(null);

  const handleCopyPlainText = () => {
    navigator.clipboard.writeText(resumeToPlainText(resume));
    setCopiedPlainText(true);
    clearTimeout(copyPlainTextTimerRef.current);
    copyPlainTextTimerRef.current = setTimeout(() => setCopiedPlainText(false), 2000);
  };
  const [jobInput, setJobInput]                 = useState("");
  const [analysisStep, setAnalysisStep]         = useState("idle");
  const [analysis, setAnalysis]                 = useState(null);
  const [analysisError, setAnalysisError]       = useState("");
  const [appliedEdits, setAppliedEdits]         = useState(new Set());

  useEffect(() => {
    api.getResume(auth.token)
      .then(({ resume: r, name }) => {
        if (r) { setResume(normalizeResume(r)); setResumeName(name || "My Resume"); }
        else    { setShowImportLanding(true); }
      })
      .catch(() => setShowImportLanding(true))
      .finally(() => setLoadingResume(false));
  }, []);

  const hasData = () => !!(resume.basics.name || resume.experience.length || resume.education.length);

  const handleImportFile = async (file) => {
    setImportError(""); setImporting(true);
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
    setAnalysis(null);
    setAnalysisStep("idle");
    setAppliedEdits(new Set());
    setImportSuccess(true);
    if (importSuccessTimer.current) clearTimeout(importSuccessTimer.current);
    importSuccessTimer.current = setTimeout(() => setImportSuccess(false), 7000);
    requestAnimationFrame(() => {
      if (editorScrollRef.current) editorScrollRef.current.scrollTop = 0;
    });
  };

  // Editor mutations preserve shape (spread-based), so skip normalization on
  // every keystroke. Normalization happens at boundaries: load, save, preview,
  // analyze, export.
  const handleChange = (next) => setResume(next);

  const handleGoPreview = async () => {
    // Block when any link has only one of {label, url} — empty pairs are fine
    // (they get filtered on export), but half-filled ones leak into the DOCX.
    const halfFilledLinks = (resume.basics?.links || [])
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => {
        const hasLabel = !!(l?.label || "").trim();
        const hasUrl   = !!(l?.url   || "").trim();
        return (hasLabel && !hasUrl) || (!hasLabel && hasUrl);
      });
    if (halfFilledLinks.length > 0) {
      const summary = halfFilledLinks
        .map(({ l }) => {
          const lab = (l?.label || "").trim();
          const url = (l?.url   || "").trim();
          if (lab && !url) return `“${lab}” is missing a URL`;
          return `a link with URL “${url}” is missing a label`;
        })
        .join("; ");
      setPreviewError(`Complete or remove these links before previewing: ${summary}.`);
      return;
    }
    setPreviewError("");

    const cleaned = normalizeResume({
      ...resume,
      experience: resume.experience.map((e) => ({ ...e, points: e.points.filter((p) => p.trim()) })),
      projects:   resume.projects.map((p)   => ({ ...p, points: p.points.filter((pt) => pt.trim()) })),
    });
    setResume(cleaned);
    setSaveMsg("Saving your changes…"); setSaving(true);
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
      const normalized = normalizeResume(resume);
      await api.saveResume(normalized, resumeName, auth.token);
      setSaveMsg("Saved!"); setIsImported(false);
      clearTimeout(saveMsgTimerRef.current);
      saveMsgTimerRef.current = setTimeout(() => setSaveMsg(""), 2000);
    } catch {
      setSaveMsg("Save failed");
      clearTimeout(saveMsgTimerRef.current);
      saveMsgTimerRef.current = setTimeout(() => setSaveMsg(""), 4000);
    }
    finally { setSaving(false); }
  };

  const handleExport = async (filename) => {
    setExporting(true);
    setExportError("");
    try {
      const blob = await api.exportDocx(resume, auth.token);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `${filename || resumeName || "Resume"}.docx`; a.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
    } catch (err) {
      console.error("Export error:", err.message);
      setExportError("Export failed. Please try again.");
    }
    finally { setExporting(false); }
  };

  const handleAnalyze = async () => {
    if (!jobInput.trim()) return;
    setAnalysisError(""); setAnalysisStep("loading");
    try {
      const text = resumeToPlainText(resume);
      if (!text.trim()) { setAnalysisError("Your resume is empty — fill in the editor first."); setAnalysisStep("idle"); return; }

      // Pass the structured resume so the backend safety net can enforce
      // bullet-count caps on ADDs (guest flow leaves this null).
      const data = await api.analyze(text, jobInput.trim(), "paste", auth.token, normalizeResume(resume));
      const { creditsRemaining, ...analysisData } = data;
      setAnalysis(analysisData); setAnalysisStep("results"); setAppliedEdits(new Set());
      if (onAnalysisComplete) onAnalysisComplete(creditsRemaining);
    } catch (err) {
      if (err.code === "NO_CREDITS" || err.message?.includes("No credits")) {
        if (onOpenBuyModal) onOpenBuyModal();
      } else {
        setAnalysisError(err.message);
      }
      setAnalysisStep("idle");
    }
  };

  const handleApplyEdit = (editIdx, edit) => {
    const next = applyEditToResume(resume, edit);
    if (next) { setResume(normalizeResume(next)); setAppliedEdits((prev) => new Set([...prev, editIdx])); return true; }
    return false;
  };

  const handleApplyAll = () => {
    if (!analysis?.edits) return;
    let working = resume;
    const newApplied = new Set(appliedEdits);
    analysis.edits.forEach((edit, idx) => {
      if (newApplied.has(idx)) return;
      const next = applyEditToResume(working, edit);
      if (next) { working = next; newApplied.add(idx); }
    });
    setResume(normalizeResume(working));
    setAppliedEdits(newApplied);
  };

  if (loadingResume) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 50px)" }}>
        <Spinner label="Loading your resume…" />
      </div>
    );
  }

  const confirmModal = pendingImport && (
    <ConfirmModal
      title="Replace current resume?"
      body="This will overwrite your current resume data with the imported content. This cannot be undone."
      confirmLabel="Replace Resume"
      onConfirm={() => applyImport(pendingImport)}
      onCancel={() => setPendingImport(null)}
    />
  );

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
  const resumeIsEmpty =
    !resume.basics.name &&
    !resume.experience.length &&
    !resume.projects.length &&
    !resume.education.length;

  const jiStyle = {
    width: "100%", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 10,
    color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 14, padding: "12px 16px",
    outline: "none", boxSizing: "border-box",
  };

  // ── Stage 1: Analyze + Edit ───────────────────────────────────────────────
  if (stage === "edit") {
    return (
      <>
        {confirmModal}
        <input
          ref={replaceFileRef}
          type="file"
          accept=".pdf,.docx,.doc"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files[0]; if (f) { e.target.value = ""; handleImportFile(f); } }}
        />

        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>

          <div style={NAV.style} height={NAV.height}>
            <input
              value={resumeName}
              onChange={(e) => setResumeName(e.target.value)}
              style={{ background: "transparent", border: "none", outline: "none", color: "#111827", fontFamily: "'Roboto',sans-serif", fontSize: 13, fontWeight: 600, minWidth: 0 }}
              placeholder="Resume name"
            />
            <Stepper stage="edit" />
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
              {saveMsg && <span style={{ fontSize: 13, color: saveMsg === "Saved!" ? "#059669" : "#DC2626" }}>{saveMsg}</span>}
              <GhostBtn onClick={() => replaceFileRef.current.click()} disabled={importing} style={{ fontSize: 13, padding: "7px 14px" }}>
                Replace Resume
              </GhostBtn>
              <GhostBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "7px 14px" }}>
                {saving ? "Saving…" : "Save"}
              </GhostBtn>
              <PrimaryBtn onClick={handleGoPreview} disabled={saving} style={{ padding: "8px 18px", fontSize: 13 }}>
                {saving ? "Saving…" : "Preview →"}
              </PrimaryBtn>
            </div>
          </div>

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

          {importError && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "#FEF2F2", borderBottom: "1px solid #FECACA", flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: "#DC2626", flex: 1, lineHeight: 1.5 }}>{importError}</span>
              <button onClick={() => setImportError("")} style={{ background: "none", border: "none", color: "#FCA5A5", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>
            </div>
          )}

          {previewError && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "#FEF2F2", borderBottom: "1px solid #FECACA", flexShrink: 0 }}>
              <span style={{ fontSize: 12, color: "#DC2626", flex: 1, lineHeight: 1.5 }}>{previewError}</span>
              <button onClick={() => setPreviewError("")} style={{ background: "none", border: "none", color: "#FCA5A5", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>
            </div>
          )}

          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

            {/* LEFT — Analysis + History */}
            <div style={{ flex: "0 0 45%", borderRight: "1px solid #E5E7EB", display: "flex", flexDirection: "column", background: "#F8FAFC", overflow: "hidden" }}>
              {/* Tab header */}
              <div style={{ display: "flex", borderBottom: "1px solid #E5E7EB", background: "#FFFFFF", flexShrink: 0 }}>
                <RightTab label="Analysis" active={leftTab === "analyze"} onClick={() => setLeftTab("analyze")} />
                <RightTab label="History"  active={leftTab === "history"} onClick={() => setLeftTab("history")} />
              </div>

              {/* History tab */}
              {leftTab === "history" && (
                <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                  <HistoryPanel
                    auth={auth}
                    onLoad={(result) => {
                      setAnalysis(result);
                      setAnalysisStep("results");
                      setAppliedEdits(new Set());
                      setLeftTab("analyze");
                    }}
                  />
                </div>
              )}

              {/* Analyze tab */}
              {leftTab === "analyze" && (
                <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                  {analysisStep === "idle" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <p style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.6, margin: 0 }}>
                        Paste a job description to score your resume and get edit suggestions you can apply directly.
                      </p>
                      {analysisError && (
                        <p style={{ color: "#DC2626", fontSize: 12, margin: 0, background: "#FEF2F2", padding: "8px 12px", borderRadius: 6, border: "1px solid #FECACA" }}>{analysisError}</p>
                      )}
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280" }}>Job Description</span>
                      <textarea style={{ ...jiStyle, minHeight: 140, resize: "vertical" }} placeholder="Paste the full job description here…" value={jobInput} onChange={(e) => setJobInput(e.target.value)} />
                      <p style={{ fontSize: 11, color: "#9CA3AF", margin: 0, lineHeight: 1.5 }}>For best results, paste the full job description.</p>
                      <PrimaryBtn onClick={handleAnalyze} disabled={!jobInput.trim() || resumeIsEmpty} style={{ width: "100%", padding: "12px", fontSize: 14 }}>
                        Analyze →
                      </PrimaryBtn>
                      {resumeIsEmpty && (
                        <p style={{ fontSize: 11, color: "#9CA3AF", margin: 0, textAlign: "center" }}>
                          Fill in your resume on the right before analyzing.
                        </p>
                      )}
                      {creditBalance !== null && (
                        <p style={{ fontSize: 12, color: "#9CA3AF", margin: 0, textAlign: "center" }}>
                          ⚡ {creditBalance} credit{creditBalance === 1 ? "" : "s"} remaining
                        </p>
                      )}
                    </div>
                  )}

                  {analysisStep === "loading" && <Spinner label="Analyzing your resume…" />}

                  {hasAnalysis && (
                    <AnalysisInsights
                      analysis={analysis}
                      onReset={() => { setAnalysis(null); setAnalysisStep("idle"); }}
                      onApply={handleApplyEdit}
                      onApplyAll={handleApplyAll}
                      onGoPreview={handleGoPreview}
                      appliedEdits={appliedEdits}
                    />
                  )}
                </div>
              )}
            </div>

            {/* RIGHT — Editor */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#F8FAFC", overflow: "hidden", position: "relative" }}>
              {importing && (
                <div style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(248,250,252,0.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                  <Spinner label="Importing resume and preparing your editor…" />
                </div>
              )}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #E5E7EB", background: "#FFFFFF", flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6B7280" }}>Editor</span>
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

  // ── Stage 2: Preview ──────────────────────────────────────────────────────
  if (stage === "preview") {
    return (
      <>
        {showExportModal && (
          <ExportModal
            resume={resume}
            onExport={handleExport}
            onCancel={() => { setShowExportModal(false); setExportError(""); }}
            exporting={exporting}
            error={exportError}
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>
          <div style={NAV.style}>
            <GhostBtn onClick={() => setStage("edit")} style={{ fontSize: 13, padding: "7px 16px", justifySelf: "start" }}>← Edit</GhostBtn>
            <Stepper stage="preview" />
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
              <GhostBtn onClick={handleCopyPlainText} style={{ fontSize: 13, padding: "7px 14px" }}>
                {copiedPlainText ? "✓ Copied" : "Copy as plain text"}
              </GhostBtn>
              <PrimaryBtn onClick={() => setShowExportModal(true)} style={{ fontSize: 13, padding: "8px 16px" }}>Export DOCX</PrimaryBtn>
              <div title={!hasAnalysis ? "Run analysis in Stage 1 to unlock outreach" : ""} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                <GhostBtn onClick={() => setStage("outreach")} disabled={!hasAnalysis} style={{ fontSize: 13, padding: "7px 14px" }}>
                  Outreach →
                </GhostBtn>
                {!hasAnalysis && <span style={{ fontSize: 10, color: "#9CA3AF", letterSpacing: "0.04em" }}>Run analysis first</span>}
              </div>
            </div>
          </div>
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
        <div style={NAV.style}>
          <GhostBtn onClick={() => setStage("preview")} style={{ fontSize: 13, padding: "7px 16px", justifySelf: "start" }}>← Preview</GhostBtn>
          <Stepper stage="outreach" />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <PrimaryBtn
              onClick={() => { setJobInput(""); setAnalysis(null); setAnalysisStep("idle"); setStage("edit"); }}
              style={{ padding: "8px 18px", fontSize: 13 }}
            >
              Analyze Another Job →
            </PrimaryBtn>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 24px", maxWidth: 720, width: "100%", margin: "0 auto" }}>
          <OutreachSection analysis={analysis} />
        </div>
      </div>
    );
  }

  return null;
}

// ── Legal helpers ─────────────────────────────────────────────────────────────
function LegalPage({ title, subtitle, children, onBack }) {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 100px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 28, fontFamily: "'Roboto',sans-serif", padding: 0 }}>← Back</button>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginBottom: 6 }}>{title}</h1>
      {subtitle && <p style={{ fontSize: 14, color: "#6B7280", marginBottom: 6 }}>{subtitle}</p>}
      <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 40, borderBottom: "1px solid #E5E7EB", paddingBottom: 20 }}>Last updated: May 2026</div>
      <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.9, display: "flex", flexDirection: "column", gap: 32 }}>
        {children}
      </div>
    </div>
  );
}

function L({ title, children }) {
  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid #F3F4F6" }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

// ── Contact page ──────────────────────────────────────────────────────────────
function ContactPage({ onBack }) {
  return (
    <LegalPage title="Contact Us" subtitle="We're here to help with any questions about your account, payments, or the service." onBack={onBack}>
      <L title="Email Support">
        <p>Send us an email and we'll respond within <strong>48 business hours</strong>.</p>
        <p>
          <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB", textDecoration: "none", fontWeight: 600 }}>
            support@resumecopilot.in
          </a>
        </p>
      </L>
      <L title="What to Include">
        <p>To help us resolve your issue quickly, please include:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>The email address associated with your account</li>
          <li>A brief description of your issue or question</li>
          <li>Your Stripe payment receipt number (if related to billing)</li>
        </ul>
      </L>
      <L title="Business Details">
        <p><strong>Resume CoPilot</strong></p>
        <p>A product of Ashborn Technologies</p>
        <p>India</p>
        <p style={{ marginTop: 8, fontSize: 13, color: "#6B7280" }}>
          For billing disputes, please contact us before initiating a chargeback — we will resolve all valid issues promptly.
        </p>
      </L>
    </LegalPage>
  );
}

// ── Pricing page ──────────────────────────────────────────────────────────────
function PricingPage({ onBack, onSignUp, auth, onGoEditor }) {
  const [currencyData, setCurrencyData] = useState(null);
  const ctaHandler = auth ? onGoEditor : onSignUp;
  const ctaLabel   = auth ? "Open editor →" : "Get started →";

  useEffect(() => {
    api.getCurrency()
      .then(setCurrencyData)
      .catch(() => setCurrencyData({
        currency: "usd",
        packages: [
          { key: "starter", credits: 5,  price: "$2.50",  per_analysis: "$0.50/analysis" },
          { key: "pro",     credits: 15, price: "$6.00",  per_analysis: "$0.40/analysis" },
          { key: "power",   credits: 40, price: "$14.00", per_analysis: "$0.35/analysis" },
        ],
      }));
  }, []);

  const PKG_META = {
    starter: { label: "Starter", desc: "Great for a single job search sprint." },
    pro:     { label: "Pro",     desc: "Best for an active multi-week search." },
    power:   { label: "Power",   desc: "Most value for serious job seekers.", best: true },
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px 100px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", marginBottom: 32, fontFamily: "'Roboto',sans-serif", padding: 0 }}>← Back</button>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "#111827", marginBottom: 12 }}>Simple, transparent pricing</h1>
        <p style={{ fontSize: 15, color: "#6B7280", maxWidth: 420, margin: "0 auto" }}>
          Buy credits as you need them. No subscriptions, no hidden fees. Each analysis costs 1 credit.
        </p>
        {currencyData && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#9CA3AF" }}>
            Prices shown in {currencyData.currency === "inr" ? "Indian Rupees (₹)" : "US Dollars ($)"} based on your location.
          </div>
        )}
      </div>

      {!currencyData ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {[1,2,3].map(n => <div key={n} style={{ height: 260, background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: 16, animation: "pulse 1.2s ease-in-out infinite" }} />)}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          {currencyData.packages.map((pkg) => {
            const meta = PKG_META[pkg.key] ?? { label: pkg.key, desc: "" };
            return (
              <div key={pkg.key} style={{ border: meta.best ? "2px solid #2563EB" : "1px solid #E5E7EB", borderRadius: 16, padding: "28px 24px", background: meta.best ? "#EFF6FF" : "#FFFFFF", position: "relative", display: "flex", flexDirection: "column", gap: 12 }}>
                {meta.best && (
                  <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: "#2563EB", color: "#FFFFFF", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 14px", borderRadius: 12, whiteSpace: "nowrap" }}>
                    Best Value
                  </div>
                )}
                <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>{meta.label}</div>
                <div style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.5 }}>{meta.desc}</div>
                <div style={{ borderTop: "1px solid #E5E7EB", paddingTop: 16, marginTop: 4 }}>
                  <span style={{ fontSize: 32, fontWeight: 700, color: "#111827", fontFamily: "'Space Mono',monospace" }}>{pkg.price}</span>
                </div>
                <div style={{ fontSize: 13, color: "#2563EB", fontWeight: 600 }}>{pkg.credits} analyses</div>
                <div style={{ fontSize: 12, color: "#9CA3AF" }}>{pkg.per_analysis}</div>
                <button
                  onClick={ctaHandler}
                  style={{ marginTop: "auto", background: meta.best ? "#2563EB" : "transparent", color: meta.best ? "#FFFFFF" : "#2563EB", border: meta.best ? "none" : "1px solid #BFDBFE", borderRadius: 10, padding: "11px 0", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Roboto',sans-serif" }}
                >
                  {ctaLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 48, background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 16, padding: "28px 32px" }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 16 }}>What you get with every credit</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            ["Match score", "See how well your resume fits the job (0–100%)."],
            ["Keyword gap analysis", "Missing keywords that ATS systems look for."],
            ["Tailored suggestions", "Exact edits to improve your resume for that role."],
            ["Outreach messages", "Ready-to-send LinkedIn note + cold email draft."],
          ].map(([title, desc]) => (
            <div key={title} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ width: 18, height: 18, background: "#D1FAE5", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                <span style={{ fontSize: 10, color: "#059669" }}>✓</span>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{title}</div>
                <div style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.5 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 24, textAlign: "center", fontSize: 12, color: "#9CA3AF" }}>
        Credits never expire. Secure payment via Stripe.{" "}
        <span style={{ color: "#6B7280" }}>Questions?{" "}</span>
        <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB", textDecoration: "none" }}>support@resumecopilot.in</a>
      </div>
    </div>
  );
}

// ── Privacy Policy ────────────────────────────────────────────────────────────
function PrivacyPage({ onBack }) {
  return (
    <LegalPage title="Privacy Policy" subtitle="Resume CoPilot is committed to protecting your personal data." onBack={onBack}>
      <L title="1. Who We Are">
        <p>Resume CoPilot ("we", "us", "our") is a product of <strong>Ashborn Technologies</strong>, India. We operate the website and AI-powered resume analysis service at this domain.</p>
        <p>Contact: <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB" }}>support@resumecopilot.in</a></p>
      </L>
      <L title="2. Information We Collect">
        <p><strong>Account information:</strong> Your email address and a hashed password when you register.</p>
        <p><strong>Resume and job data:</strong> Resume text and job descriptions you submit for analysis. This content is processed by our AI service and stored to provide the editor and history features.</p>
        <p><strong>Payment information:</strong> We do not store card details. All payment processing is handled by Stripe, Inc. We receive only a payment confirmation and your Stripe customer reference.</p>
        <p><strong>Usage data:</strong> Your IP address (used for regional pricing and guest rate-limiting), browser type, and general usage patterns.</p>
      </L>
      <L title="3. How We Use Your Information">
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
          <li>To provide, operate, and improve the Resume CoPilot service</li>
          <li>To process payments and manage your credit balance</li>
          <li>To detect and prevent fraud and abuse</li>
          <li>To respond to support requests</li>
          <li>To determine regional pricing (IP-based, not stored beyond the session)</li>
        </ul>
        <p>We do not sell, rent, or share your personal data with third parties for marketing purposes.</p>
      </L>
      <L title="4. Third-Party Services">
        <p>We use the following third-party services to operate Resume CoPilot:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
          <li><strong>Stripe</strong> — payment processing. Stripe's privacy policy applies to all payment data. See <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "#2563EB" }}>stripe.com/privacy</a>.</li>
          <li><strong>Anthropic (Claude AI)</strong> — resume analysis. Your resume text and job descriptions are sent to Anthropic's API for processing. See <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "#2563EB" }}>anthropic.com/privacy</a>.</li>
          <li><strong>Neon (PostgreSQL)</strong> — secure cloud database for storing your account and resume data.</li>
          <li><strong>ipapi.co</strong> — IP-based geolocation used solely to determine your currency for pricing. Your IP is not stored by us beyond a 24-hour in-memory cache.</li>
        </ul>
      </L>
      <L title="5. Data Retention">
        <p>Your account data and resumes are retained for as long as your account is active. You may request deletion of your account and all associated data at any time by emailing <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB" }}>support@resumecopilot.in</a>.</p>
        <p>Anonymized usage logs may be retained for up to 90 days for debugging and service improvement.</p>
      </L>
      <L title="6. Data Security">
        <p>All data is transmitted over HTTPS. Passwords are stored as bcrypt hashes and are never stored in plain text. We use industry-standard security practices to protect your data.</p>
        <p>However, no internet transmission is 100% secure. If you suspect unauthorized access to your account, contact us immediately.</p>
      </L>
      <L title="7. Your Rights">
        <p>Under India's Digital Personal Data Protection Act (DPDPA) 2023 and applicable laws, you have the right to:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
          <li>Access the personal data we hold about you</li>
          <li>Correct inaccurate personal data</li>
          <li>Request deletion of your personal data</li>
          <li>Withdraw consent for data processing</li>
        </ul>
        <p>To exercise any of these rights, email <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB" }}>support@resumecopilot.in</a>. We will respond within 30 days.</p>
      </L>
      <L title="8. Cookies">
        <p>Resume CoPilot uses only a single authentication token stored in your browser's <code style={{ background: "#F3F4F6", padding: "1px 5px", borderRadius: 4 }}>localStorage</code> to keep you logged in. We do not use advertising cookies or third-party tracking cookies.</p>
      </L>
      <L title="9. Changes to This Policy">
        <p>We may update this Privacy Policy from time to time. The "Last updated" date at the top of this page will reflect any changes. Continued use of the service after changes constitutes acceptance.</p>
      </L>
    </LegalPage>
  );
}

// ── Terms of Service ──────────────────────────────────────────────────────────
function TermsPage({ onBack }) {
  return (
    <LegalPage title="Terms of Service" subtitle="Please read these terms carefully before using Resume CoPilot." onBack={onBack}>
      <L title="1. Acceptance of Terms">
        <p>By creating an account or using Resume CoPilot, you agree to be bound by these Terms of Service. If you do not agree, do not use the service.</p>
      </L>
      <L title="2. Description of Service">
        <p>Resume CoPilot is an AI-powered tool that helps users analyze their resumes against job descriptions, identify keyword gaps, generate tailored suggestions, and draft outreach messages. The service is provided "as is" and results are generated by AI — they are suggestions, not guarantees of employment outcomes.</p>
      </L>
      <L title="3. Account Registration">
        <p>You must provide a valid email address to create an account. You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. You must be at least 18 years old to use the service.</p>
      </L>
      <L title="4. Credits and Payments">
        <p>Resume CoPilot operates on a credit system. Each AI analysis costs 1 credit. New accounts receive 5 free credits upon registration. Additional credits can be purchased through our Stripe-powered checkout.</p>
        <p>Prices are displayed in INR (Indian Rupees) for users in India and USD (US Dollars) for international users, based on your location at the time of purchase.</p>
        <p>All payments are processed by Stripe and are subject to Stripe's terms of service. We do not store your payment card information.</p>
        <p>Credits do not expire. Credits are non-transferable between accounts.</p>
      </L>
      <L title="5. Acceptable Use">
        <p>You agree not to:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
          <li>Use the service to process content you do not have the right to share</li>
          <li>Attempt to reverse-engineer or scrape the service</li>
          <li>Use automated tools to abuse the free tier or bypass rate limits</li>
          <li>Submit content that is illegal, harmful, or violates third-party rights</li>
          <li>Resell or sublicense access to the service</li>
        </ul>
      </L>
      <L title="6. AI-Generated Content">
        <p>Outputs generated by Resume CoPilot are produced by an AI language model and may contain inaccuracies. You are solely responsible for reviewing, editing, and verifying any content before using it in a job application. Resume CoPilot does not guarantee employment outcomes.</p>
      </L>
      <L title="7. Intellectual Property">
        <p>The Resume CoPilot platform, its design, and underlying technology are owned by Ashborn Technologies. You retain ownership of the resume content and job descriptions you submit.</p>
        <p>By using the service, you grant us a limited, non-exclusive license to process your submitted content solely for the purpose of providing the service to you.</p>
      </L>
      <L title="8. Termination">
        <p>We reserve the right to suspend or terminate accounts that violate these terms. You may delete your account at any time by contacting us. Upon termination, unused credits are forfeited unless otherwise required by law.</p>
      </L>
      <L title="9. Disclaimer of Warranties">
        <p>The service is provided "as is" without warranties of any kind, express or implied. We do not warrant that the service will be uninterrupted, error-free, or meet your specific requirements.</p>
      </L>
      <L title="10. Limitation of Liability">
        <p>To the maximum extent permitted by law, Ashborn Technologies shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of Resume CoPilot. Our total liability to you for any claim shall not exceed the amount you paid us in the 30 days preceding the claim.</p>
      </L>
      <L title="11. Governing Law">
        <p>These Terms are governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of the courts in India.</p>
      </L>
      <L title="12. Changes to Terms">
        <p>We may update these Terms at any time. Continued use of the service after changes are posted constitutes your acceptance of the new Terms. We will notify registered users of material changes via email.</p>
      </L>
      <L title="13. Contact">
        <p>For any questions about these Terms, contact us at <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB" }}>support@resumecopilot.in</a>.</p>
      </L>
    </LegalPage>
  );
}

// ── Refund Policy ─────────────────────────────────────────────────────────────
function RefundPage({ onBack }) {
  return (
    <LegalPage title="Refund Policy" subtitle="We want you to be satisfied with Resume CoPilot." onBack={onBack}>
      <L title="Digital Credits — General Policy">
        <p>Resume CoPilot sells digital credits that are consumed when you run an AI analysis. Because credits are a digital consumable, <strong>used credits are non-refundable</strong> once an analysis has been successfully delivered.</p>
      </L>
      <L title="When Refunds Are Available">
        <p>We offer refunds in the following situations:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          <li>
            <strong>Unused credits within 7 days of purchase:</strong> If you purchased credits and have not used any of them, you may request a full refund within 7 days of the purchase date.
          </li>
          <li>
            <strong>Technical failure:</strong> If a credit was deducted but no analysis result was delivered due to a confirmed technical error on our end, we will restore the credit or issue a refund.
          </li>
          <li>
            <strong>Duplicate charges:</strong> If you were charged more than once for the same transaction, we will refund the duplicate charge immediately upon verification.
          </li>
        </ul>
      </L>
      <L title="How to Request a Refund">
        <p>Email us at <a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB", fontWeight: 600 }}>support@resumecopilot.in</a> with:</p>
        <ul style={{ paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
          <li>Your registered email address</li>
          <li>The Stripe payment receipt / transaction ID</li>
          <li>The reason for your refund request</li>
        </ul>
      </L>
      <L title="Processing Time">
        <p>We will review and respond to all refund requests within <strong>3 business days</strong>. Approved refunds are processed through Stripe and typically appear in your account within 5–10 business days depending on your bank or card issuer.</p>
      </L>
      <L title="Chargebacks">
        <p>We strongly encourage you to contact us before initiating a chargeback with your bank. We resolve valid disputes promptly. Unwarranted chargebacks may result in account suspension.</p>
      </L>
      <L title="Contact">
        <p><a href="mailto:support@resumecopilot.in" style={{ color: "#2563EB" }}>support@resumecopilot.in</a></p>
      </L>
    </LegalPage>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────
function Footer({ onNav }) {
  const link = (label, page, url) => (
    <button
      onClick={() => { onNav(page, url); window.scrollTo(0, 0); }}
      style={{ background: "none", border: "none", color: "#9CA3AF", cursor: "pointer", fontSize: 12, padding: 0, fontFamily: "'Roboto',sans-serif", textDecoration: "none" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "#6B7280")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "#9CA3AF")}
    >
      {label}
    </button>
  );
  return (
    <div style={{ borderTop: "1px solid #E5E7EB", background: "#FFFFFF", padding: "24px 28px", marginTop: "auto" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
        <span style={{ fontSize: 12, color: "#9CA3AF" }}>© 2026 Resume CoPilot · Ashborn Technologies</span>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          {link("Pricing",        "pricing", "/pricing")}
          {link("Contact",        "contact", "/contact")}
          {link("Privacy Policy", "privacy", "/privacy")}
          {link("Terms of Service","terms",  "/terms")}
          {link("Refund Policy",  "refund",  "/refund")}
        </div>
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [auth, setAuth]         = useState(loadAuth);
  const [page, setPage]         = useState(() => {
    const path = window.location.pathname;
    if (path === "/credits/success")  return "credits-success";
    if (path === "/credits/cancel")   return "credits-cancel";
    if (path === "/pricing")          return "pricing";
    if (path === "/contact")          return "contact";
    if (path === "/privacy")          return "privacy";
    if (path === "/terms")            return "terms";
    if (path === "/refund")           return "refund";
    if (path === "/forgot-password")  return "forgot-password";
    if (path === "/reset-password")   return "reset-password";
    if (path === "/account")          return "account";
    return "home";
  });

  const navigate = (p, url) => {
    setPage(p);
    if (url) window.history.pushState({}, "", url);
    else window.history.pushState({}, "", "/");
  };
  const [authMode, setAuthMode] = useState("login");
  const [creditBalance, setCreditBalance] = useState(null);
  const [showBuyModal, setShowBuyModal]   = useState(false);

  const fetchCredits = async (knownBalance) => {
    if (knownBalance !== undefined && knownBalance !== null) {
      setCreditBalance(knownBalance);
      return;
    }
    if (!auth?.token) return;
    try {
      const data = await api.getCredits(auth.token);
      setCreditBalance(data.balance);
    } catch { /* non-fatal */ }
  };

  useEffect(() => {
    if (auth?.token) fetchCredits();
    else setCreditBalance(null);
  }, [auth?.token]);

  // Sync page state with browser back/forward navigation
  useEffect(() => {
    const pathToPage = (path) => {
      if (path === "/credits/success")  return "credits-success";
      if (path === "/credits/cancel")  return "credits-cancel";
      if (path === "/pricing")         return "pricing";
      if (path === "/contact")         return "contact";
      if (path === "/privacy")         return "privacy";
      if (path === "/terms")           return "terms";
      if (path === "/refund")          return "refund";
      if (path === "/forgot-password") return "forgot-password";
      if (path === "/reset-password")  return "reset-password";
      if (path === "/account")         return "account";
      return "home";
    };
    const handlePop = () => setPage(pathToPage(window.location.pathname));
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  const handleAuth = (data) => {
    setAuth(data); saveAuth(data); setPage("editor");
    // Balance will load via useEffect watching auth.token
  };
  const handleLogout = () => { setAuth(null); clearAuth(); setCreditBalance(null); setPage("home"); };
  const handleAccountDeleted = () => { setAuth(null); clearAuth(); setCreditBalance(null); navigate("home"); };
  const goLogin    = () => { setAuthMode("login");    setPage("login"); };
  const goRegister = () => { setAuthMode("register"); setPage("login"); };

  return (
    <ErrorBoundary>
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
        .tab-btn { background:transparent; border:1px solid #E5E7EB; color:#6B7280; cursor:pointer; padding:7px 18px; font-size:12px; font-family:'Roboto',sans-serif; font-weight:500; letter-spacing:0.03em; text-transform:uppercase; transition:all 0.15s; }
        .tab-btn.active { background:#EFF6FF; border-color:#93C5FD; color:#2563EB; }
        ${PREVIEW_CSS}
      `}</style>

      {showBuyModal && auth && (
        <BuyCreditsModal auth={auth} onClose={() => setShowBuyModal(false)} />
      )}

      <div style={{ background: "#F8FAFC", minHeight: "100vh", color: "#111827", fontFamily: "'Roboto',sans-serif", display: "flex", flexDirection: "column" }}>

        {/* Navbar */}
        <div style={{ borderBottom: "1px solid #E5E7EB", padding: "13px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#FFFFFF", zIndex: 20 }}>
          <button onClick={() => navigate("home")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 14, color: "#111827" }}>Resume CoPilot</span>
          </button>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              onClick={() => navigate("pricing", "/pricing")}
              style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 13, fontFamily: "'Roboto',sans-serif", padding: "4px 8px" }}
            >
              Pricing
            </button>
            {auth ? (
              <>
                <CreditsBadge balance={creditBalance} onOpenModal={() => setShowBuyModal(true)} />
                <button
                  onClick={() => navigate("account", "/account")}
                  title={`${auth.user?.email} — account settings`}
                  style={{
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    fontFamily: "'Roboto',sans-serif",
                    fontSize: 12, color: "#6B7280",
                    maxWidth: 200, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                    textDecoration: "underline", textDecorationColor: "transparent",
                    transition: "text-decoration-color 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecorationColor = "#9CA3AF")}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecorationColor = "transparent")}
                >
                  {auth.user?.email}
                </button>
                <GhostBtn onClick={handleLogout} style={{ fontSize: 12, padding: "5px 14px" }}>Logout</GhostBtn>
              </>
            ) : (
              <>
                <GhostBtn onClick={goLogin}      style={{ fontSize: 12, padding: "5px 14px" }}>Login</GhostBtn>
                <PrimaryBtn onClick={goRegister}  style={{ fontSize: 12, padding: "6px 16px" }}>Sign Up</PrimaryBtn>
              </>
            )}
          </div>
        </div>

        {/* Pages */}
        <div className="fade-in" key={page} style={{ flex: 1 }}>
          {page === "home"    && <HomePage auth={auth} onGuest={() => setPage("guest")} onLogin={goLogin} onGoEditor={() => setPage("editor")} onPricing={() => navigate("pricing", "/pricing")} />}
          {page === "guest"   && <GuestPage onBack={() => navigate("home")} onSignUp={goRegister} />}
          {page === "login"   && (
            <AuthPage
              mode={authMode}
              onAuth={handleAuth}
              onToggle={() => setAuthMode(authMode === "login" ? "register" : "login")}
              onBack={() => navigate("home")}
              onForgot={() => navigate("forgot-password", "/forgot-password")}
            />
          )}
          {page === "forgot-password" && (
            <ForgotPasswordPage
              onBack={() => navigate("home")}
              onGoLogin={() => { setAuthMode("login"); navigate("login"); }}
            />
          )}
          {page === "reset-password" && (
            <ResetPasswordPage
              onGoLogin={() => { setAuthMode("login"); navigate("login"); }}
            />
          )}
          {page === "account" && auth && (
            <AccountPage
              auth={auth}
              onBack={() => navigate("home")}
              onDeleted={handleAccountDeleted}
            />
          )}
          {page === "account" && !auth && (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <p style={{ color: "#6B7280", marginBottom: 16 }}>Please log in to view your account.</p>
              <PrimaryBtn onClick={goLogin}>Login</PrimaryBtn>
            </div>
          )}
          {page === "editor"  && auth && (
            <EditorPage
              auth={auth}
              creditBalance={creditBalance}
              onOpenBuyModal={() => setShowBuyModal(true)}
              onAnalysisComplete={fetchCredits}
            />
          )}
          {page === "editor"  && !auth && (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <p style={{ color: "#6B7280", marginBottom: 16 }}>Please log in to access the editor.</p>
              <PrimaryBtn onClick={goLogin}>Login</PrimaryBtn>
            </div>
          )}
          {page === "credits-success" && (
            <CreditsSuccessPage
              auth={auth}
              onGoEditor={() => setPage(auth ? "editor" : "home")}
              onCreditsFetched={setCreditBalance}
            />
          )}
          {page === "credits-cancel" && (
            <CreditsCancelPage onGoEditor={() => setPage(auth ? "editor" : "home")} />
          )}
          {page === "pricing" && (
            <PricingPage
              onBack={() => navigate("home")}
              onSignUp={goRegister}
              auth={auth}
              onGoEditor={() => setPage("editor")}
            />
          )}
          {page === "contact" && <ContactPage onBack={() => navigate("home")} />}
          {page === "privacy" && <PrivacyPage onBack={() => navigate("home")} />}
          {page === "terms"   && <TermsPage   onBack={() => navigate("home")} />}
          {page === "refund"  && <RefundPage  onBack={() => navigate("home")} />}
        </div>

        <Footer onNav={navigate} />
      </div>
    </ErrorBoundary>
  );
}
