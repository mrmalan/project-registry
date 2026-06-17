// netlify/functions/process-notes.js
// Scheduled function — runs every 30 min
// Reads session notes from Google Drive, parses them, writes to Sheet via Apps Script

export const config = { schedule: "*/30 * * * *" };

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SECRET = 'reg_' + (process.env.GOOGLE_SHEET_ID || '1nDPexqyLe').slice(0, 8);
const ARCHIVE_FOLDER_NAME = 'Archive';

// ── Get fresh Google access token ──
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── List files in Drive folder ──
async function listFiles(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

// ── Get file content ──
async function getFileContent(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return await res.text();
}

// ── Update file content (mark as processed) ──
async function updateFileContent(token, fileId, content) {
  await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: content,
    }
  );
}

// ── Move file to Archive subfolder ──
async function archiveFile(token, fileId, folderId) {
  // Find or create Archive folder
  const q = encodeURIComponent(`name = 'Archive' and '${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  let archiveId;
  if (data.files && data.files.length > 0) {
    archiveId = data.files[0].id;
  } else {
    const created = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Archive', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }),
    });
    const folder = await created.json();
    archiveId = folder.id;
  }
  // Move file: add to archive, remove from parent
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${archiveId}&removeParents=${folderId}&fields=id`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
  );
}

// ── Section parser ──
function extractField(content, name) {
  const m = content.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : '';
}

function extractSection(content, name) {
  // Exact match first (standard format)
  const escapedFull = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternFull = new RegExp(
    `^${escapedFull}[^\\n]*\\n(?:[-─=]+\\n)?([\\s\\S]+?)(?=\\n[A-Z][A-Z &()\\/\\-—]+(?:\\n|\\s*[-─=])|\\n={3,}|$)`,
    'im'
  );
  const mFull = content.match(patternFull);
  if (mFull) {
    let text = mFull[1].trim();
    text = text.replace(/\n[A-Z][A-Z &()\/\-—]+\s*$/m, '').trim();
    return text.replace(/^[-*•]\s*/gm, '').trim();
  }

  // Fallback: loose match for ──── divider format
  const coreName = name
    .replace(/ — ADD$/i, '').replace(/ — DONE\/REMOVE$/i, '').replace(/ — RESOLVED\/REMOVE$/i, '')
    .replace(/ THIS SESSION$/i, '').replace(/ \(to add\)$/i, '');
  const escapedCore = coreName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalised = content.replace(/^[─=]{4,}\s*$/gm, '###DIV###');
  const patternLoose = new RegExp(
    `###DIV###\\n[^\\n]*${escapedCore}[^\\n]*\\n###DIV###\\n([\\s\\S]+?)(?=###DIV###|$)`,
    'i'
  );
  const mLoose = normalised.match(patternLoose);
  if (!mLoose) return '';
  return mLoose[1].replace(/###DIV###/g, '').replace(/^[-*•]\s*/gm, '').trim();
}

function extractList(content, name) {
  const section = extractSection(content, name);
  if (!section) return [];
  return section.split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(l => l.length > 0 && !l.match(/^[─=]{3,}/));
}

function parseDocs(raw) {
  const docs = [];
  let cur = {};
  for (const line of raw.split('\n')) {
    const t = line.match(/^Type:\s*(.+)/i);
    const l = line.match(/^Label:\s*(.+)/i);
    const u = line.match(/^URL:\s*(.+)/i);
    if (t) { if (cur.label) docs.push(cur); cur = { type: t[1].trim(), label: '', url: '' }; }
    else if (l && cur.type) cur.label = l[1].trim();
    else if (u && cur.type) cur.url = u[1].trim();
    else {
      const bullet = line.match(/^[-*]\s+(.+)/);
      if (bullet && !cur.type) {
        const label = bullet[1].split(/\s+[—\-]+\s+/)[0].replace(/_/g, ' ').trim();
        if (label) docs.push({ type: 'Doc', label, url: '' });
      }
    }
  }
  if (cur.label) docs.push(cur);
  return docs;
}

function mkTask(t) {
  return typeof t === 'string' ? { text: t, dueDate: null, reminderDate: null }
    : { text: t.text || '', dueDate: t.dueDate || null, reminderDate: t.reminderDate || null };
}
function taskText(t) { return typeof t === 'string' ? t : (t.text || ''); }

// ── Write project update to Sheet via Apps Script ──
async function patchProject(update) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, action: 'patch', project: update }),
  });
  return await res.json();
}

async function getProjects() {
  const res = await fetch(`${APPS_SCRIPT_URL}?secret=${encodeURIComponent(SECRET)}`, { redirect: 'follow' });
  return await res.json();
}

// ── Process a single note ──
async function processNote(content, fileName) {
  // Extract project name
  let projectTitle = extractField(content, 'PROJECT');
  if (!projectTitle) {
    const m = content.match(/^SESSION NOTE[\s—\-]+(.+)$/im);
    if (m) projectTitle = m[1].trim();
  }
  if (!projectTitle) {
    console.log(`No PROJECT field in ${fileName} — skipping`);
    return null;
  }

  const status = extractField(content, 'STATUS');
  const whatWasDone = extractSection(content, 'WHAT WAS DONE THIS SESSION') || extractSection(content, 'WHAT WAS DONE');
  const nextAdd = extractList(content, 'NEXT ACTIONS — ADD').concat(extractList(content, 'NEXT ACTIONS (to add)'));
  const nextRemove = extractList(content, 'NEXT ACTIONS — DONE/REMOVE');
  const openAdd = extractList(content, 'OPEN ITEMS — ADD').concat(extractList(content, 'OPEN ITEMS'));
  const openRemove = extractList(content, 'OPEN ITEMS — RESOLVED/REMOVE');
  const docsRaw = extractSection(content, 'DOCUMENTS ADDED') || extractSection(content, 'NEW DOCUMENTS');
  const stackUpdate = extractSection(content, 'STACK / CONTACTS UPDATE');
  const sessionNotes = extractSection(content, 'SESSION NOTES');

  console.log(`Processing: ${fileName} → ${projectTitle}`);
  console.log(`Next add: ${JSON.stringify(nextAdd)}`);
  console.log(`Open add: ${JSON.stringify(openAdd)}`);

  // Get current project from Sheet
  const projects = await getProjects();
  let project = projects.find(p =>
    p.title?.toLowerCase() === projectTitle.toLowerCase() ||
    p.id?.toLowerCase() === projectTitle.toLowerCase().replace(/[^a-z0-9]/g, '-')
  );

  if (!project) {
    // New project
    project = {
      id: projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      title: projectTitle,
      sub: '',
      status: status || 'active',
      lastUpdate: whatWasDone || '',
      next: [],
      open: [],
      openReminders: {},
      docs: [],
      stack: '',
      notes: [],
      updatedAt: new Date().toLocaleString('en-ZA'),
    };
  }

  // Apply updates
  if (status) project.status = status;
  if (whatWasDone) project.lastUpdate = whatWasDone;
  if (stackUpdate && stackUpdate.length > 2) project.stack = stackUpdate;

  // Merge next actions
  let next = (project.next || []).map(mkTask);
  nextAdd.forEach(text => {
    if (text && !next.find(t => taskText(t) === text)) next.push(mkTask(text));
  });
  nextRemove.forEach(text => { next = next.filter(t => taskText(t) !== text); });
  project.next = next;

  // Merge open items
  let open = [...(project.open || [])];
  openAdd.forEach(item => { if (item && !open.includes(item)) open.push(item); });
  openRemove.forEach(item => { open = open.filter(x => x !== item); });
  project.open = open;

  // Merge docs
  if (docsRaw) {
    const newDocs = parseDocs(docsRaw);
    const docs = [...(project.docs || [])];
    newDocs.forEach(doc => { if (!docs.find(d => d.label === doc.label)) docs.push(doc); });
    project.docs = docs;
  }

  // Append session note log entry
  const ts = new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  const entry = `[${ts}] ${whatWasDone ? whatWasDone.substring(0, 150) : fileName}${sessionNotes ? ' | ' + sessionNotes.substring(0, 100) : ''}`;
  project.notes = [entry, ...(project.notes || [])];
  project.updatedAt = ts;

  return project;
}

// ── Main handler ──
export default async function handler() {
  console.log('process-notes: starting');
  try {
    const token = await getAccessToken();
    const files = await listFiles(token, FOLDER_ID);
    console.log(`Found ${files.length} files in folder`);

    let processed = 0;
    for (const file of files) {
      const name = file.name || '';
      if (!name.toLowerCase().includes('sessionnote')) continue;
      if (name.match(/^TEMPLATE_/i) || name.match(/^README/i)) continue;

      const content = await getFileContent(token, file.id);
      console.log(`Read ${name}: ${content.length} chars, has newlines: ${content.includes('\n')}`);

      const processedField = extractField(content, 'PROCESSED');
      if (processedField.toLowerCase() === 'yes') continue;

      const updated = await processNote(content, name);
      if (!updated) continue;

      // Write to Sheet
      await patchProject(updated);

      // Mark processed
      const newContent = content.replace(/^PROCESSED:\s*no/im, 'PROCESSED: yes');
      await updateFileContent(token, file.id, newContent);

      // Archive
      await archiveFile(token, file.id, FOLDER_ID);

      console.log(`✓ Processed and archived: ${name} → ${updated.title}`);
      processed++;
    }

    console.log(`process-notes: done. Processed ${processed} note(s).`);
  } catch (err) {
    console.error('process-notes error:', err);
  }
}
