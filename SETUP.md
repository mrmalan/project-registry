# Project Registry — Setup Guide

## What you have
- `src/App.jsx` — Full React registry UI (reads/writes via Netlify Functions)
- `netlify/functions/sheet.js` — Google Sheets API proxy (keeps service account key server-side)
- `netlify/functions/claude.js` — Anthropic API proxy
- `scripts/SessionNoteProcessor.gs` — Google Apps Script (watches Drive, updates Sheet)
- Google Sheet ID: `1nDPexqypLeC5YFhSFi9ArHJ2lJsucpsm0RcpVeKPzgc`

---

## Step 1 — Google Service Account (15 min, one-time)

You need a service account so the Netlify Function can write to your Sheet without OAuth.

1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one) → name it "Project Registry"
3. Enable the **Google Sheets API**:
   - APIs & Services → Library → search "Google Sheets API" → Enable
4. Create a Service Account:
   - APIs & Services → Credentials → Create Credentials → Service Account
   - Name: `project-registry-writer` → Create
   - Skip optional steps → Done
5. Click the service account → Keys tab → Add Key → JSON → Download
   - Keep this file safe — you'll paste its contents into Netlify
6. Share your Google Sheet with the service account email (looks like `project-registry-writer@your-project.iam.gserviceaccount.com`):
   - Open the Sheet → Share → paste the email → Editor → Send

---

## Step 2 — GitHub Repo

Run in Command Prompt (replace YOUR_PAT with your GitHub Personal Access Token):

```
curl -X POST https://api.github.com/user/repos ^
  -H "Authorization: token YOUR_PAT" ^
  -H "Content-Type: application/json" ^
  -d "{\"name\": \"project-registry\", \"private\": false, \"description\": \"Project registry with Google Sheets backend\"}"
```

Then scaffold locally:

```
cd C:\Users\LATITUDE 5290\Dropbox\Projects
npm create vite@latest project-registry -- --template react
cd project-registry
npm install
```

Copy these files into the scaffolded folder (replace what's there):
- `src/App.jsx` → replace the generated one
- `src/main.jsx` → replace the generated one
- `netlify/functions/claude.js` → create netlify/functions/ folder first
- `netlify/functions/sheet.js`
- `netlify.toml` → project root
- `.gitignore` → project root (add to existing)

Then push:

```
git init
git add .
git commit -m "Initial project registry"
git branch -M main
git remote add origin https://github.com/mrmalan/project-registry.git
git push -u origin main
```

---

## Step 3 — Netlify Deploy

1. Go to app.netlify.com → Add new site → Import from GitHub → select `project-registry`
2. Build settings: command = `npm run build`, publish = `dist`
3. Deploy site
4. Rename site: Site settings → General → Site name → `project-registry`
5. Add environment variables (Site settings → Environment variables):

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (sk-ant-...) |
| `GOOGLE_SHEET_ID` | `1nDPexqypLeC5YFhSFi9ArHJ2lJsucpsm0RcpVeKPzgc` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Paste the entire contents of the JSON file you downloaded in Step 1 |

6. Trigger a redeploy after adding env vars: Deploys → Trigger deploy

Your registry will be live at https://project-registry.netlify.app

---

## Step 4 — Seed the Google Sheet

1. Open the Sheet: https://docs.google.com/spreadsheets/d/1nDPexqypLeC5YFhSFi9ArHJ2lJsucpsm0RcpVeKPzgc
2. Go to Extensions → Apps Script
3. Paste the entire contents of `scripts/SessionNoteProcessor.gs`
4. Save the project (name it "Session Note Processor")
5. Run `seedFromDefaults` once manually:
   - Select `seedFromDefaults` from the function dropdown → Run
   - Approve permissions when prompted (it needs Drive + Sheets access)
6. Run `setupTrigger` to install the 30-minute polling trigger:
   - Select `setupTrigger` → Run

After seeding, refresh your Netlify app — all 10 projects will load from the Sheet.

---

## Step 5 — Verify the flow

1. Open https://project-registry.netlify.app — should show all 10 projects
2. Click a card — detail page should open
3. Edit a project — save — check the Sheet updates
4. In Claude, say "save a session note" — note appears in Drive folder
5. Wait up to 30 min (or run `processUnreadNotes` manually in Apps Script) — note gets processed into the Sheet
6. Refresh the registry — updates appear

---

## How the auto-sync works (ongoing)

```
Claude session ends
    → Claude saves note to Drive folder (Claude Project Session Notes)
    → Apps Script runs every 30 min
    → Finds files with PROCESSED: no
    → Parses structured sections
    → Updates Google Sheet (adds next actions, open items, docs, notes)
    → Marks note PROCESSED: yes and moves to Archive/
    → Registry reads fresh data from Sheet on next load
```

---

## Troubleshooting

**Registry shows "Failed to load"**
- Check Netlify Function logs: Netlify dashboard → Functions → sheet
- Verify GOOGLE_SERVICE_ACCOUNT_JSON is valid JSON (no truncation)
- Confirm service account has Editor access to the Sheet

**Apps Script fails**
- Check execution log: Apps Script → Executions
- Confirm it has Drive and Sheets permissions (run any function → approve)
- Check FOLDER_ID matches your Drive folder

**Session notes not processing**
- Confirm note file ends in `_SessionNote.txt`
- Check PROCESSED field is exactly `PROCESSED: no` (case-insensitive)
- Run `processUnreadNotes` manually to see logs
