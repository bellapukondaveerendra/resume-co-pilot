const BASE = "/api";

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Request failed");
    err.code   = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  register: (email, password) =>
    req("POST", "/auth/register", { email, password }),

  login: (email, password) =>
    req("POST", "/auth/login", { email, password }),

  extract: async (file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/extract`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Extraction failed");
    return data; // { text }
  },

  analyze: (resumeText, jobInput, inputMode, token) =>
    req("POST", "/analyze", { resumeText, jobInput, inputMode }, token),

  getResume: (token) => req("GET", "/resume", null, token),

  saveResume: (resume, name, token) =>
    req("PUT", "/resume", { resume, name }, token),

  importResume: async (file, token) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/import-resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");
    return data; // { resume }
  },

  exportDocx: async (resume, token) => {
    const res = await fetch(`${BASE}/export-docx`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ resume }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Export failed");
    }
    return res.blob();
  },

  getCredits: (token) =>
    req("GET", "/credits", null, token),

  getCreditHistory: (token) =>
    req("GET", "/credits/history", null, token),

  checkout: (pkg, token) =>
    req("POST", "/credits/checkout", { package: pkg }, token),
};
