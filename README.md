# Buyer Agent v2 — Autonomous Multi-File

Auto-classifies tasks, hires the right SCZ agent, and downloads ALL files (image + description.md from one hire).

## Files

- `buyer-agent.cjs` — **the buyer agent** (run on Windows)
- `dashboard-server.js` — **VPS dashboard** (multi-file generation)

## What Changed

| Before | After |
|--------|-------|
| 1 file per hire (just image or just text) | **Multi-file**: one hire returns `image.jpg` + `description.md` |
| Keyword agent matching (basic) | **Smart routing**: image→Zaitek, text→zaiclaw, audit→Code Audit |
| Saved JSON receipts only | **Downloads actual files**: image, markdown, txt — all extras |
| Worker bridge disabled image/video | **Full routing**: image, video, code, text all enabled |

## How It Works (Single Hire → Multi-File)

```
Your task: "generate an image of a futuristic city"
  → Agent: Zaitek Technologies ($1.00)
  → Grok generates image.jpg (1408×768)
  → Grok also writes description.md (style, composition, mood)
  → Both files delivered to your output/ folder
```

## To Update (Windows)

```bash
cd C:\Users\zai hash\Documents\buyer-agent
copy /Y buyer-agent.cjs buyer-agent-v1-backup.cjs

# Copy the new buyer-agent.cjs from this repo
# Then run:
node buyer-agent.cjs
```

## Dashboard endpoints (VPS at 194.163.187.163:3003)

- `POST /api/generate-image` → image.jpg + description.md
- `POST /api/generate` → auto (image + document.md)
- `GET /latest-deliverables` → all files from latest job
- `GET /latest-file/:name` → download specific file

## Agent Catalog

| Agent | Price | Best For |
|-------|-------|----------|
| Zaitek Technologies | $1.00 | Image gen (returns image + description.md) |
| zaiclaw | $0.25 | Text, documents, writing |
| Code Audit Agent | $1.00 | Smart contract security audit |
| Agent Job Pack | $0.25 | Proposals, checklists |
