// netlify/functions/sheet.js
// Proxies Google Sheets API — keeps service account key server-side

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// ── Get a Google OAuth2 token from service account credentials ──
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const signingInput = `${encode(header)}.${encode(claim)}`;

  // Import private key and sign
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(SERVICE_ACCOUNT.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

// ── Parse sheet rows into project objects ──
function rowsToProjects(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const p = {};
    headers.forEach((h, i) => { p[h] = row[i] || ''; });
    // Parse JSON fields
    ['next', 'open', 'openReminders', 'docs', 'notes'].forEach((f) => {
      try { p[f] = JSON.parse(p[f] || (f === 'openReminders' ? '{}' : '[]')); }
      catch { p[f] = f === 'openReminders' ? {} : []; }
    });
    return p;
  });
}

// ── Serialise a project back to a row ──
function projectToRow(p, headers) {
  return headers.map((h) => {
    if (['next', 'open', 'openReminders', 'docs', 'notes'].includes(h)) {
      return JSON.stringify(p[h] ?? (h === 'openReminders' ? {} : []));
    }
    return p[h] ?? '';
  });
}

export async function handler(event) {
  const method = event.httpMethod;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  try {
    const token = await getAccessToken();
    const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
    const authHeader = { Authorization: `Bearer ${token}` };

    // ── GET — read all projects ──
    if (method === 'GET') {
      const res = await fetch(`${baseUrl}/values/Sheet1`, { headers: authHeader });
      const data = await res.json();
      const projects = rowsToProjects(data.values);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(projects),
      };
    }

    // ── PUT — full project list write ──
    if (method === 'PUT') {
      const projects = JSON.parse(event.body);
      const headers = ['id','title','sub','status','lastUpdate','next','open','openReminders','docs','stack','notes','updatedAt'];
      const rows = [headers, ...projects.map((p) => projectToRow(p, headers))];

      await fetch(`${baseUrl}/values/Sheet1?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: 'Sheet1', majorDimension: 'ROWS', values: rows }),
      });

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
    }

    // ── PATCH — update single project by id ──
    if (method === 'PATCH') {
      const update = JSON.parse(event.body);

      // Read current data
      const res = await fetch(`${baseUrl}/values/Sheet1`, { headers: authHeader });
      const data = await res.json();
      const values = data.values || [];
      const sheetsHeaders = values[0] || [];
      const idColIdx = sheetsHeaders.indexOf('id');

      // Find row
      let rowIdx = -1;
      for (let i = 1; i < values.length; i++) {
        if (values[i][idColIdx] === update.id) { rowIdx = i; break; }
      }

      if (rowIdx < 0) {
        // New project — append
        const newRow = projectToRow(update, sheetsHeaders);
        await fetch(`${baseUrl}/values/Sheet1!A${values.length + 1}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [newRow] }),
        });
      } else {
        // Update existing
        const updatedRow = sheetsHeaders.map((h, i) => {
          if (Object.prototype.hasOwnProperty.call(update, h)) {
            if (['next', 'open', 'openReminders', 'docs', 'notes'].includes(h)) {
              return JSON.stringify(update[h]);
            }
            return update[h];
          }
          return values[rowIdx][i] ?? '';
        });

        const sheetRow = rowIdx + 1;
        await fetch(`${baseUrl}/values/Sheet1!A${sheetRow}?valueInputOption=RAW`, {
          method: 'PUT',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ range: `Sheet1!A${sheetRow}`, majorDimension: 'ROWS', values: [updatedRow] }),
        });
      }

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('sheet function error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
