import { useState, useEffect } from "react";

// ── Shared input styles ────────────────────────────────────────────────────────

function borderColor(warn) { return warn ? "#c8a000" : "#D1D5DB"; }

const baseInput = (warn) => ({
  width: "100%",
  background: "#FFFFFF",
  color: "#111827",
  border: `1px solid ${borderColor(warn)}`,
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
  outline: "none",
  fontFamily: "'Roboto', sans-serif",
  boxSizing: "border-box",
});

// ── Field ──────────────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, multiline, isImported }) {
  const warn = isImported && !value;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: warn ? "#c8a000" : "#6B7280" }}>
        {label}
        {warn && <span title="Not extracted — fill this in">⚠</span>}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...baseInput(warn), minHeight: 72, resize: "vertical" }}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={baseInput(warn)}
        />
      )}
    </label>
  );
}

// ── SkillItemsField ────────────────────────────────────────────────────────────
// Keeps raw comma text while typing; parses on blur only so "C++," stays intact.

function SkillItemsField({ items, onChange, isImported }) {
  const [text, setText] = useState(items.join(", "));
  const warn = isImported && items.length === 0;

  useEffect(() => {
    setText(items.join(", "));
  }, [items.join("|")]);

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: warn ? "#c8a000" : "#6B7280" }}>
        Items
        {warn && <span title="No skills extracted — add them here">⚠</span>}
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text.split(",").map((x) => x.trim()).filter(Boolean))}
        placeholder="React, Node.js, PostgreSQL"
        style={baseInput(warn)}
      />
    </label>
  );
}

// ── IconBtn ────────────────────────────────────────────────────────────────────

function IconBtn({ children, onClick, tone = "ghost", title }) {
  const colors = {
    ghost:   { bg: "transparent", border: "#E5E7EB",  color: "#6B7280"  },
    primary: { bg: "#EFF6FF",     border: "#93C5FD",  color: "#2563EB"  },
    danger:  { bg: "#FEF2F2",     border: "#FECACA",  color: "#DC2626"  },
  };
  const c = colors[tone] || colors.ghost;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: c.bg, border: `1px solid ${c.border}`, color: c.color,
        borderRadius: 8, padding: "6px 11px", fontSize: 11, fontWeight: 600,
        cursor: "pointer", whiteSpace: "nowrap", fontFamily: "'Roboto', sans-serif",
      }}
    >
      {children}
    </button>
  );
}

// ── SectionCard ────────────────────────────────────────────────────────────────

function SectionCard({ title, subtitle, children, onAdd, addLabel }) {
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 12, lineHeight: 1.6, color: "#6B7280" }}>{subtitle}</p>}
        </div>
        {onAdd && <IconBtn onClick={onAdd} tone="primary">{addLabel}</IconBtn>}
      </div>
      {children}
    </div>
  );
}

// ── BulletList ─────────────────────────────────────────────────────────────────

function BulletList({ points, onChange, placeholder = "Bullet point…", isImported }) {
  const warn = isImported && points.length === 0;
  const edit   = (i, val) => onChange(points.map((p, idx) => (idx === i ? val : p)));
  const remove = (i) => onChange(points.filter((_, idx) => idx !== i));
  const add    = () => onChange([...points, ""]);

  const inputStyle = {
    flex: 1, background: "#FFFFFF", color: "#111827", border: "1px solid #D1D5DB",
    borderRadius: 8, padding: "8px 10px", fontSize: 12, outline: "none",
    fontFamily: "'Roboto', sans-serif", lineHeight: 1.5, resize: "vertical",
    minHeight: 36, boxSizing: "border-box",
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 7,
      ...(warn ? { border: "1px solid #FDE68A", borderRadius: 8, padding: 8 } : {}),
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: warn ? "#c8a000" : "#6B7280" }}>
        Bullet Points
        {warn && <span title="No bullets extracted — add them manually">⚠</span>}
      </span>
      {points.map((pt, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ color: "#CBD5E1", fontSize: 14, paddingTop: 9, flexShrink: 0 }}>•</span>
          <textarea value={pt} onChange={(e) => edit(i, e.target.value)} placeholder={placeholder} style={inputStyle} rows={2} />
          <IconBtn tone="danger" onClick={() => remove(i)} title="Delete">×</IconBtn>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        style={{
          background: "transparent", border: "1px dashed #D1D5DB", color: "#9CA3AF",
          borderRadius: 8, padding: "7px 12px", fontSize: 11, cursor: "pointer",
          fontFamily: "'Roboto', sans-serif", textAlign: "left",
        }}
      >
        + Add bullet
      </button>
    </div>
  );
}

// ── ResumeEditor ───────────────────────────────────────────────────────────────

export default function ResumeEditor({ resume, onChange, isImported = false }) {
  const set = (key, val) => onChange({ ...resume, [key]: val });

  const upBasics = (field, val) => set("basics", { ...resume.basics, [field]: val });

  const upLink = (i, field, val) =>
    set("basics", {
      ...resume.basics,
      links: resume.basics.links.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)),
    });

  const upEntry  = (key, i, next) => set(key, resume[key].map((item, idx) => (idx === i ? next : item)));
  const addEntry = (key, tpl)      => set(key, [...resume[key], tpl]);
  const rmEntry  = (key, i)        => set(key, resume[key].filter((_, idx) => idx !== i));

  const f = (label, field, placeholder, multiline) => (
    <Field
      label={label}
      value={resume.basics[field]}
      onChange={(v) => upBasics(field, v)}
      placeholder={placeholder}
      multiline={multiline}
      isImported={isImported}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Basics */}
      <SectionCard title="Basics" subtitle="Name, contact info, and links.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {f("Name",     "name",     "Jane Smith")}
          {f("Location", "location", "San Francisco, CA")}
          {f("Email",    "email",    "jane@example.com")}
          {f("Phone",    "phone",    "+1 555 000 0000")}
        </div>

        {/* Links */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B7280" }}>Links</span>
            <IconBtn onClick={() => set("basics", { ...resume.basics, links: [...resume.basics.links, { label: "", url: "" }] })}>
              Add Link
            </IconBtn>
          </div>
          {resume.basics.links.map((l, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr auto", gap: 10, alignItems: "end" }}>
              <Field label="Label" value={l.label} onChange={(v) => upLink(i, "label", v)} />
              <Field label="URL"   value={l.url}   onChange={(v) => upLink(i, "url",   v)} />
              <IconBtn onClick={() => set("basics", { ...resume.basics, links: resume.basics.links.filter((_, idx) => idx !== i) })}>
                Remove
              </IconBtn>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Skills */}
      <SectionCard
        title="Skills"
        subtitle="Category and comma-separated items per row."
        onAdd={() => addEntry("skills", { category: "", items: [] })}
        addLabel="Add Group"
      >
        {resume.skills.map((s, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "0.8fr 1.6fr auto", gap: 10, alignItems: "end" }}>
            <Field
              label="Category"
              value={s.category}
              onChange={(v) => upEntry("skills", i, { ...s, category: v })}
              isImported={isImported}
            />
            <SkillItemsField
              items={s.items}
              onChange={(items) => upEntry("skills", i, { ...s, items })}
              isImported={isImported}
            />
            <IconBtn onClick={() => rmEntry("skills", i)}>Remove</IconBtn>
          </div>
        ))}
      </SectionCard>

      {/* Experience */}
      <SectionCard
        title="Experience"
        onAdd={() => addEntry("experience", { role: "", company: "", location: "", start: "", end: "", points: [] })}
        addLabel="Add Experience"
      >
        {resume.experience.map((e, i) => (
          <div key={i} style={{ border: "1px solid #E5E7EB", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 12, background: "#F9FAFB" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Role"     value={e.role}     onChange={(v) => upEntry("experience", i, { ...e, role:     v })} isImported={isImported} />
              <Field label="Company"  value={e.company}  onChange={(v) => upEntry("experience", i, { ...e, company:  v })} isImported={isImported} />
              <Field label="Location" value={e.location} onChange={(v) => upEntry("experience", i, { ...e, location: v })} isImported={isImported} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Start" value={e.start} onChange={(v) => upEntry("experience", i, { ...e, start: v })} isImported={isImported} />
                <Field label="End"   value={e.end}   onChange={(v) => upEntry("experience", i, { ...e, end:   v })} isImported={isImported} />
              </div>
            </div>
            <BulletList
              points={e.points}
              onChange={(pts) => upEntry("experience", i, { ...e, points: pts })}
              isImported={isImported}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <IconBtn tone="danger" onClick={() => rmEntry("experience", i)}>Remove Entry</IconBtn>
            </div>
          </div>
        ))}
      </SectionCard>

      {/* Projects */}
      <SectionCard
        title="Projects"
        onAdd={() => addEntry("projects", { name: "", points: [] })}
        addLabel="Add Project"
      >
        {resume.projects.map((p, i) => (
          <div key={i} style={{ border: "1px solid #E5E7EB", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 12, background: "#F9FAFB" }}>
            <Field
              label="Project Name"
              value={p.name}
              onChange={(v) => upEntry("projects", i, { ...p, name: v })}
              isImported={isImported}
            />
            <BulletList
              points={p.points}
              onChange={(pts) => upEntry("projects", i, { ...p, points: pts })}
              isImported={isImported}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <IconBtn tone="danger" onClick={() => rmEntry("projects", i)}>Remove Project</IconBtn>
            </div>
          </div>
        ))}
      </SectionCard>

      {/* Education */}
      <SectionCard
        title="Education"
        onAdd={() => addEntry("education", { institution: "", degree: "", start: "", end: "", coursework: "" })}
        addLabel="Add Education"
      >
        {resume.education.map((e, i) => (
          <div key={i} style={{ border: "1px solid #E5E7EB", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 12, background: "#F9FAFB" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Institution" value={e.institution} onChange={(v) => upEntry("education", i, { ...e, institution: v })} isImported={isImported} />
              <Field label="Degree"      value={e.degree}      onChange={(v) => upEntry("education", i, { ...e, degree:      v })} isImported={isImported} />
              <Field label="Start"       value={e.start}       onChange={(v) => upEntry("education", i, { ...e, start:       v })} isImported={isImported} />
              <Field label="End"         value={e.end}         onChange={(v) => upEntry("education", i, { ...e, end:         v })} isImported={isImported} />
            </div>
            <Field
              label="Coursework / Details"
              value={e.coursework}
              onChange={(v) => upEntry("education", i, { ...e, coursework: v })}
              placeholder="Relevant coursework, GPA, certifications…"
              multiline
              isImported={isImported}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <IconBtn tone="danger" onClick={() => rmEntry("education", i)}>Remove Education</IconBtn>
            </div>
          </div>
        ))}
      </SectionCard>

    </div>
  );
}
