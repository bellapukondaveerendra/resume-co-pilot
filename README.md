# ⚡ CoPilot — AI Job Application Assistant

> Paste a job. Get your match score, resume fixes, and outreach messages ready in minutes.

---

## 🚀 Quick Start (Local Setup)

### Prerequisites
- Node.js 18+ installed → https://nodejs.org
- An Anthropic API key → https://console.anthropic.com

---

### 1. Add your API Key

Open `backend/.env` and replace the placeholder:

```
ANTHROPIC_API_KEY=your_actual_key_here
```

---

### 2. Start the Backend

```bash
cd backend
npm install
npm run dev
```

You should see:
```
✅ CoPilot backend running on http://localhost:3001
```

---

### 3. Start the Frontend (new terminal tab)

```bash
cd frontend
npm install
npm run dev
```

You should see:
```
  VITE ready on http://localhost:5173
```

---

### 4. Open in browser

Go to: **http://localhost:5173**

---

## 📁 Project Structure

```
job-copilot/
├── backend/
│   ├── server.js        ← Express API server
│   ├── .env             ← 🔑 Put your API key here
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx      ← Full React UI
│   │   └── main.jsx     ← Entry point
│   ├── index.html
│   ├── vite.config.js   ← Proxies /api → backend
│   └── package.json
└── README.md
```

---

## 🔑 How the API Key Works

- Your key lives only in `backend/.env` — never touches the browser
- Frontend calls `/api/analyze` → Vite proxies it to `localhost:3001`
- Backend calls Anthropic with your key server-side ✅

---

## ⚠️ Tips

- **Job URL mode**: Claude infers context from the URL. For best results, paste the full job description using "Paste JD" mode.
- **Resume upload**: Works best with `.txt` files or copy-pasted text. PDF upload extracts raw text (works for text-based PDFs, not scanned ones).
- **API costs**: Each analysis uses ~1,000–1,500 tokens. At current Sonnet pricing, that's roughly $0.003–$0.005 per analysis.

---

## 🛣️ What to Build Next

- [ ] Job URL scraping with Jina.ai reader API (`r.jina.ai/{url}`)
- [ ] PDF parsing with `pdf-parse` npm package on the backend
- [ ] Save/export results as PDF
- [ ] Application tracker (SQLite or Supabase)
- [ ] Follow-up reminder system
