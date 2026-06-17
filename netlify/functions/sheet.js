// netlify/functions/sheet.js
// Proxies all Sheets reads/writes through the Apps Script Web App
// No service account needed — Apps Script runs as the sheet owner

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SECRET = 'reg_' + (process.env.GOOGLE_SHEET_ID || '1nDPexqypLe').slice(0, 8);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (!APPS_SCRIPT_URL) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'APPS_SCRIPT_URL not configured' }) };
  }

  try {
    // ── GET: read all projects (or sync if ?action=sync) ──
    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters?.action || '';
      const url = `${APPS_SCRIPT_URL}?secret=${encodeURIComponent(SECRET)}${action ? '&action=' + action : ''}`;
      const res = await fetch(url, { redirect: 'follow' });
      const data = await res.json();
      return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    }

    // ── PUT: replace all projects ──
    if (event.httpMethod === 'PUT') {
      const projects = JSON.parse(event.body);
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SECRET, action: 'put', projects }),
      });
      const data = await res.json();
      return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    }

    // ── PATCH: upsert single project ──
    if (event.httpMethod === 'PATCH') {
      const project = JSON.parse(event.body);
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SECRET, action: 'patch', project }),
      });
      const data = await res.json();
      return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
    }

    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('sheet function error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
}
