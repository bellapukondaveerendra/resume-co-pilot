// ── Canonical resume schema ───────────────────────────────────────────────────
// This is the single source of truth for the resume data shape.
// All backend and frontend code must use this structure.

export const EMPTY_RESUME = {
  basics: {
    name: "",
    email: "",
    phone: "",
    location: "",
    links: [
      { label: "LinkedIn", url: "" },
      { label: "GitHub",   url: "" },
    ],
  },
  skills:     [{ category: "Programming", items: [] }],
  experience: [],
  projects:   [],
  education:  [],
};

// Normalizes any partial or legacy resume object into the canonical shape.
// Handles old field names (school → institution, details[] → coursework string).
export function normalizeResume(r = EMPTY_RESUME) {
  return {
    basics: {
      name:     r.basics?.name     || "",
      email:    r.basics?.email    || "",
      phone:    r.basics?.phone    || "",
      location: r.basics?.location || "",
      links: (r.basics?.links?.length
        ? r.basics.links
        : [{ label: "", url: "" }]
      ).map((l) => ({ label: l?.label || "", url: l?.url || "" })),
    },
    skills: (r.skills?.length ? r.skills : EMPTY_RESUME.skills).map((s) => ({
      category: s?.category || "",
      items:    Array.isArray(s?.items) ? s.items.filter(Boolean) : [],
    })),
    experience: (r.experience || []).map((e) => ({
      role:     e?.role     || "",
      company:  e?.company  || "",
      location: e?.location || "",
      start:    e?.start    || "",
      end:      e?.end      || "",
      points:   (e?.points || []).map((p) => (typeof p === "string" ? p : p?.text || "")),
    })),
    projects: (r.projects || []).map((p) => ({
      name:   p?.name || "",
      points: (p?.points || []).map((pt) => (typeof pt === "string" ? pt : pt?.text || "")),
    })),
    education: (r.education || []).map((e) => ({
      // backwards-compat: old data may use `school` or `details[]`
      institution: e?.institution || e?.school || "",
      degree:      e?.degree      || "",
      start:       e?.start       || "",
      end:         e?.end         || "",
      coursework:  typeof e?.coursework === "string"
        ? e.coursework
        : Array.isArray(e?.details) ? e.details.filter(Boolean).join(", ") : "",
    })),
  };
}

// Plain-text representation used for AI analysis.
export function resumeToPlainText(resume) {
  const d = normalizeResume(resume);
  const lines = [];

  if (d.basics.name) lines.push(d.basics.name);
  const contact = [d.basics.location, d.basics.phone, d.basics.email].filter(Boolean);
  if (contact.length) lines.push(contact.join(" | "));
  const linkLine = d.basics.links
    .filter((l) => l.label || l.url)
    .map((l) => [l.label, l.url].filter(Boolean).join(": "))
    .join(" | ");
  if (linkLine) lines.push(linkLine);

  if (d.skills.some((s) => s.items.length)) {
    lines.push("", "TECHNICAL SKILLS");
    for (const s of d.skills) {
      if (!s.category && !s.items.length) continue;
      lines.push(`${s.category}: ${s.items.join(", ")}`);
    }
  }

  if (d.experience.length) {
    lines.push("", "PROFESSIONAL EXPERIENCE");
    for (const e of d.experience) {
      lines.push([e.role, e.company && `\u2013 ${e.company}`, e.location].filter(Boolean).join(" "));
      lines.push([e.start, e.end].filter(Boolean).join(" \u2013 "));
      for (const p of e.points) lines.push(`\u2022 ${p}`);
      lines.push("");
    }
  }

  if (d.projects.length) {
    lines.push("PROJECTS");
    for (const p of d.projects) {
      lines.push(p.name);
      for (const pt of p.points) lines.push(`\u2022 ${pt}`);
      lines.push("");
    }
  }

  if (d.education.length) {
    lines.push("EDUCATION");
    for (const e of d.education) {
      lines.push(e.institution);
      if (e.degree)     lines.push(e.degree);
      lines.push([e.start, e.end].filter(Boolean).join(" \u2013 "));
      if (e.coursework) lines.push(e.coursework);
      lines.push("");
    }
  }

  return lines
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
}

// HTML string used for the live preview panel.
export function resumeToHtml(resume) {
  const d = normalizeResume(resume);
  const esc = (v) =>
    String(v || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const contactParts = [d.basics.location, d.basics.phone, d.basics.email].filter(Boolean).map(esc);
  for (const l of d.basics.links) {
    if (!l.label && !l.url) continue;
    const label = esc(l.label || l.url);
    const href  = esc(l.url || "#");
    contactParts.push(`<a href="${href}">${label}</a>`);
  }

  const skillsHtml = d.skills
    .filter((s) => s.category || s.items.length)
    .map((s) => `<div class="skill-row"><strong>${esc(s.category)}:</strong> ${esc(s.items.join(", "))}</div>`)
    .join("");

  const expHtml = d.experience
    .map((e) => {
      let title = `<strong>${esc(e.role)}`;
      if (e.company) title += ` \u2013 ${esc(e.company)}`;
      title += `</strong>`;
      if (e.location) title += `, ${esc(e.location)}`;
      const dates = [e.start, e.end].filter(Boolean).join(" \u2013 ");
      return `<div class="entry">
        <div class="entry-head">
          <div class="entry-title">${title}</div>
          ${dates ? `<div class="entry-dates"><strong>${esc(dates)}</strong></div>` : ""}
        </div>
        ${e.points.length ? `<ul>${e.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      </div>`;
    })
    .join("");

  const projHtml = d.projects
    .map((p) => `<div class="entry">
      <div class="entry-title"><strong>${esc(p.name)}</strong></div>
      ${p.points.length ? `<ul>${p.points.map((pt) => `<li>${esc(pt)}</li>`).join("")}</ul>` : ""}
    </div>`)
    .join("");

  const eduHtml = d.education
    .map((e) => {
      const dates = [e.start, e.end].filter(Boolean).join(" \u2013 ");
      return `<div class="entry">
        <div class="entry-head">
          <div class="entry-title"><strong>${esc(e.institution)}</strong></div>
          ${dates ? `<div class="entry-dates"><strong>${esc(dates)}</strong></div>` : ""}
        </div>
        ${e.degree ? `<div class="entry-degree">${esc(e.degree)}</div>` : ""}
        ${e.coursework ? `<div class="detail-lines">${esc(e.coursework)}</div>` : ""}
      </div>`;
    })
    .join("");

  return `<div class="resume-shell">
    <header class="resume-header">
      <h1>${esc(d.basics.name)}</h1>
      ${contactParts.length ? `<div class="contact-line">${contactParts.join(' <span class="sep">|</span> ')}</div>` : ""}
    </header>
    ${skillsHtml ? `<section><h2>Technical Skills</h2>${skillsHtml}</section>` : ""}
    ${expHtml   ? `<section><h2>Professional Experience</h2>${expHtml}</section>` : ""}
    ${projHtml  ? `<section><h2>Projects</h2>${projHtml}</section>` : ""}
    ${eduHtml   ? `<section><h2>Education</h2>${eduHtml}</section>` : ""}
  </div>`;
}
