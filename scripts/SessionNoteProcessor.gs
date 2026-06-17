// ============================================================
// Project Registry — Session Note Processor
// Google Apps Script
//
// SETUP:
// 1. Open script.google.com → New project → paste this file
// 2. Set SHEET_ID and FOLDER_ID constants below
// 3. Run setupTrigger() once manually to install the time trigger
// 4. Run processAllNotes() once manually to seed initial data
// ============================================================

var SHEET_ID = '1nDPexqypLeC5YFhSFi9ArHJ2lJsucpsm0RcpVeKPzgc';
var FOLDER_ID = '14et5aNovx3id8UH2KSgDDFnXlWP_tRlC';
var ARCHIVE_NAME = 'Archive';

// Sheet column layout (1-indexed)
var COL = {
  ID: 1,
  TITLE: 2,
  SUB: 3,
  STATUS: 4,
  LAST_UPDATE: 5,
  NEXT: 6,       // JSON array of {text, dueDate, reminderDate}
  OPEN: 7,       // JSON array of strings
  OPEN_REMINDERS: 8, // JSON object
  DOCS: 9,       // JSON array of {type, label, url}
  STACK: 10,
  NOTES: 11,     // JSON array of strings
  UPDATED_AT: 12
};
var NUM_COLS = 12;

// ── Install trigger ──────────────────────────────────────────
function setupTrigger() {
  // Delete existing triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processUnreadNotes') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('processUnreadNotes')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('Trigger installed: processUnreadNotes every 30 minutes');
}

// ── Main entry — called by trigger ──────────────────────────
function processUnreadNotes() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFiles();
  var processed = 0;

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();

    // Skip non-session-note files
    if (!name.endsWith('_SessionNote.txt') && !name.endsWith('_SessionNote')) continue;

    var content = file.getBlob().getDataAsString();

    // Skip already processed
    if (extractField(content, 'PROCESSED').toLowerCase() === 'yes') continue;

    Logger.log('Processing: ' + name);
    processNote(content, file);
    processed++;
  }

  Logger.log('Done. Processed ' + processed + ' note(s).');
}

// ── Process a single note ─────────────────────────────────────
function processNote(content, file) {
  var projectTitle = extractField(content, 'PROJECT');
  var status = extractField(content, 'STATUS');
  var whatWasDone = extractSection(content, 'WHAT WAS DONE THIS SESSION');
  var nextAdd = extractList(content, 'NEXT ACTIONS — ADD');
  var nextRemove = extractList(content, 'NEXT ACTIONS — DONE/REMOVE');
  var openAdd = extractList(content, 'OPEN ITEMS — ADD');
  var openRemove = extractList(content, 'OPEN ITEMS — RESOLVED/REMOVE');
  var docsRaw = extractSection(content, 'DOCUMENTS ADDED');
  var stackUpdate = extractSection(content, 'STACK / CONTACTS UPDATE');
  var sessionNotes = extractSection(content, 'SESSION NOTES');

  if (!projectTitle) {
    Logger.log('No PROJECT field found — skipping');
    return;
  }

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);

  var row = findOrCreateRow(sheet, projectTitle);

  // Update status if provided
  if (status && status.length > 0 && status !== '') {
    sheet.getRange(row, COL.STATUS).setValue(status);
  }

  // Update last update text
  if (whatWasDone) {
    sheet.getRange(row, COL.LAST_UPDATE).setValue(whatWasDone);
  }

  // Update stack if provided
  if (stackUpdate && stackUpdate.length > 2) {
    sheet.getRange(row, COL.STACK).setValue(stackUpdate);
  }

  // Merge next actions
  var nextJson = sheet.getRange(row, COL.NEXT).getValue();
  var nextArr = safeParseJson(nextJson, []);
  nextAdd.forEach(function(text) {
    if (text && !nextArr.find(function(t) { return taskText(t) === text; })) {
      nextArr.push({ text: text, dueDate: null, reminderDate: null });
    }
  });
  nextRemove.forEach(function(text) {
    nextArr = nextArr.filter(function(t) { return taskText(t) !== text; });
  });
  sheet.getRange(row, COL.NEXT).setValue(JSON.stringify(nextArr));

  // Merge open items
  var openJson = sheet.getRange(row, COL.OPEN).getValue();
  var openArr = safeParseJson(openJson, []);
  openAdd.forEach(function(item) {
    if (item && openArr.indexOf(item) < 0) openArr.push(item);
  });
  openRemove.forEach(function(item) {
    openArr = openArr.filter(function(x) { return x !== item; });
  });
  sheet.getRange(row, COL.OPEN).setValue(JSON.stringify(openArr));

  // Parse and add documents
  if (docsRaw) {
    var newDocs = parseDocs(docsRaw);
    if (newDocs.length > 0) {
      var docsJson = sheet.getRange(row, COL.DOCS).getValue();
      var docsArr = safeParseJson(docsJson, []);
      newDocs.forEach(function(doc) {
        if (!docsArr.find(function(d) { return d.label === doc.label; })) {
          docsArr.push(doc);
        }
      });
      sheet.getRange(row, COL.DOCS).setValue(JSON.stringify(docsArr));
    }
  }

  // Append to notes log
  var notesJson = sheet.getRange(row, COL.NOTES).getValue();
  var notesArr = safeParseJson(notesJson, []);
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');
  var noteEntry = '[' + ts + '] Session import: ' + (whatWasDone ? whatWasDone.substring(0, 120) + '...' : file.getName());
  if (sessionNotes) noteEntry += ' | Notes: ' + sessionNotes.substring(0, 200);
  notesArr.unshift(noteEntry);
  sheet.getRange(row, COL.NOTES).setValue(JSON.stringify(notesArr));

  // Set updated timestamp
  sheet.getRange(row, COL.UPDATED_AT).setValue(ts);

  // Mark note as processed
  var updatedContent = content.replace(/^PROCESSED:\s*no/im, 'PROCESSED: yes');
  file.setContent(updatedContent);

  // Move to Archive
  var archiveFolder = getOrCreateArchive(DriveApp.getFolderById(FOLDER_ID));
  archiveFolder.addFile(file);
  DriveApp.getFolderById(FOLDER_ID).removeFile(file);

  Logger.log('Processed and archived: ' + file.getName() + ' → project: ' + projectTitle);
}

// ── Seed all projects from defaults (run once manually) ──────
function seedFromDefaults() {
  var defaults = [
    { id: 'screencred', title: 'ScreenCred', sub: 'Family accountability app', status: 'active',
      lastUpdate: 'Full module set built: FamilyHub, Tasks, Skills, Audit, Settings, all child screens, CredCoach, 6 themes.',
      next: [{text:'Move to Claude Code for direct GitHub push',dueDate:null,reminderDate:null},{text:'Wire Supabase backend',dueDate:null,reminderDate:null},{text:'Fix JSX issues in Settings.tsx and Tasks.tsx',dueDate:null,reminderDate:null},{text:'Build child PIN change flow',dueDate:null,reminderDate:null},{text:'Netlify deployment',dueDate:null,reminderDate:null}],
      open: ['Supabase not yet wired','Weekly reset automation not built','No real notifications yet','SkillCred marketplace (Phase 2)'],
      docs: [{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/screencred'}],
      stack: 'React / Vite / TypeScript · github.com/mrmalan/screencred' },
    { id: 'emix-jv', title: 'EMIX JV', sub: '4-product JV with SA Lightning', status: 'active',
      lastUpdate: 'Pitch deck, HOA, capex model, 4 competitive analyses, financial dashboard all built. Phase 1 capex R3.1–4.4M.',
      next: [{text:'Confirm Averge SPD transfer price with Gerrit before pitch',dueDate:null,reminderDate:null},{text:'Structure Lectro-Tech equity/draw offer',dueDate:null,reminderDate:null},{text:'Update full business plan',dueDate:null,reminderDate:null},{text:'Submit ExoWeld DG classification',dueDate:null,reminderDate:null},{text:'ID SADC distributors (Zimbabwe + Zambia)',dueDate:null,reminderDate:null}],
      open: ['SPD COGS at 60% is placeholder — must confirm with Gerrit','Lectro-Tech not yet formally approached','Vermont Sales: bundle as install kit add-on only'],
      docs: [{type:'Deck',label:'Averge pitch deck',url:''},{type:'Model',label:'JV capex model',url:''},{type:'Doc',label:'HOA',url:''},{type:'Tool',label:'Financial dashboard',url:''}],
      stack: 'Products: EMIX-CA, LP mast rental, Raycap SPD (via Averge), ExoWeld · Contact: Jordan Watson +27 12 450 0940' },
    { id: 'volt', title: 'Volt Energy Platform', sub: 'SA energy advisory SPA', status: 'active',
      lastUpdate: 'Live at volt-energy-platform.netlify.app. Covers 8 tariffs, bill reconstruction, load growth, battery dispatch, IRR heatmap.',
      next: [{text:'Spin tariff engine into standalone volt-tariff-engine repo',dueDate:null,reminderDate:null},{text:'Expand to 160+ municipalities',dueDate:null,reminderDate:null},{text:'API-first architecture with formal versioning',dueDate:null,reminderDate:null}],
      open: ['Only 8 of 160+ target tariffs covered','Inclining block + TOU support not yet formalised'],
      docs: [{type:'Tool',label:'Live app',url:'https://volt-energy-platform.netlify.app'},{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/volt-energy-platform'}],
      stack: 'React + Vite · repo: volt-energy-platform · GitHub: mrmalan' },
    { id: 'estac-advisory', title: 'Estac Energy Advisory', sub: 'New advisory platform', status: 'building',
      lastUpdate: 'New repo estac-energy-advisory scoped. Build order defined. Strategic pivot: EaaS + battery arbitrage + behind-the-meter.',
      next: [{text:'Build tariff engine (160+ SA municipalities)',dueDate:null,reminderDate:null},{text:'Load profile engine',dueDate:null,reminderDate:null},{text:'Opportunity analysis module',dueDate:null,reminderDate:null},{text:'Battery dispatch',dueDate:null,reminderDate:null},{text:'EaaS financial model',dueDate:null,reminderDate:null},{text:'Wheeling module',dueDate:null,reminderDate:null}],
      open: ['Not yet started — scoped only'],
      docs: [{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/estac-energy-advisory'}],
      stack: 'React + Vite · repo: estac-energy-advisory' },
    { id: 'solar-yield', title: 'Solar Yield Tool', sub: 'Pre-feasibility yield calculator', status: 'active',
      lastUpdate: 'Live at solar-yield-tool.netlify.app. Yield Profile tab spans years. HelioScope parity backlog prioritised.',
      next: [{text:'POA transposition (Perez/Hay-Davies GHI→POA)',dueDate:null,reminderDate:null},{text:'Temperature-corrected cell modelling (NOCT)',dueDate:null,reminderDate:null},{text:'Satellite layout + shade analysis (Detailed mode)',dueDate:null,reminderDate:null}],
      open: ['Items 1+2 highest value for SA commercial pre-feasibility','Layout tab Detailed mode: Google Maps tile proxy not yet built'],
      docs: [{type:'Tool',label:'Live app',url:'https://solar-yield-tool.netlify.app'},{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/solar-yield-tool'}],
      stack: 'React + Vite · single App.jsx · repo: solar-yield-tool' },
    { id: 'payyourshare', title: 'PayYourShare', sub: 'Mobile bill-splitting PWA', status: 'active',
      lastUpdate: 'Live at payyourshare.netlify.app. 8-screen flow with Claude vision bill scanning, tip personalisation.',
      next: [{text:'Diagnose WhatsApp URL shortener runtime issue',dueDate:null,reminderDate:null},{text:'Test pass-the-bill URL sharing end-to-end',dueDate:null,reminderDate:null}],
      open: ['WhatsApp /api/shorten had runtime issues — pending browser console diagnosis'],
      docs: [{type:'Tool',label:'Live app',url:'https://payyourshare.netlify.app'}],
      stack: 'React + Vite + Netlify Functions · Anthropic API (vision)' },
    { id: 'lps-toolkit', title: 'Estac LPS Toolkit', sub: 'IEC 62305-3 engineering tools', status: 'active',
      lastUpdate: 'Live at earth-mat-tool.netlify.app. Earth mat, soil resistivity, separation distance, air termination, DB designer, PFC Tool.',
      next: [{text:'Add new tools as Gerrit raises requirements',dueDate:null,reminderDate:null}],
      open: ['Primary user is Gerrit — keep in sync with his workflow'],
      docs: [{type:'Tool',label:'Live app',url:'https://earth-mat-tool.netlify.app'}],
      stack: 'React + Vite + Netlify edge function · End user: Gerrit' },
    { id: 'abap-cmfp', title: 'ABAP CMFP Interface', sub: 'SAP Retail outbound PO extract', status: 'active',
      lastUpdate: 'Complete standards-compliant program ZRPRR_SREA00243CMFP_PO delivered. 4 code objects + integration guide.',
      next: [{text:'Developer to resolve 8 open items from integration guide',dueDate:null,reminderDate:null},{text:'Confirm SE11 dictionary objects and activation sequence',dueDate:null,reminderDate:null},{text:'Validate against live COR3 data',dueDate:null,reminderDate:null}],
      open: ['8 open items in integration guide for developer to confirm','Not yet tested against live system'],
      docs: [], stack: 'ABAP OO · SAP Retail COR3/Shoprite · Blue Yonder CMFP' },
    { id: 'energyduck', title: 'EnergyDuck / Eldo', sub: 'Energy retail brand + sales partner', status: 'hold',
      lastUpdate: "Duck mascot 'Bill' and brand complete. SVG logo exported. SolarAfrica and Metronomic NES agreements reviewed.",
      next: [{text:'Follow up Anuva Projects Phase 1 with Tim Ohlsen',dueDate:null,reminderDate:null},{text:'Monitor SolarAfrica agreement renegotiation',dueDate:null,reminderDate:null}],
      open: ['SolarAfrica: R0.02/kWh pipeline-gated, unilateral deal approval','Metronomic NES: USD-denominated SIP fees, perpetual patent grant-back'],
      docs: [], stack: 'Brand only · Contact: Tim Ohlsen — tim@eldoenergy.com' },
    { id: 'sawem', title: 'SAWEM / Market School', sub: 'Electricity market certification', status: 'done',
      lastUpdate: '3-day training completed 26–28 May 2026. Passed one-attempt certification exam.',
      next: [{text:'Apply market knowledge to wheeling proposals and EaaS modelling',dueDate:null,reminderDate:null}],
      open: [], docs: [], stack: 'Key terms: SMP, CfD, BRP, MO, SO, DAM, IDM, SAPP' }
  ];

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);

  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');

  defaults.forEach(function(p) {
    var row = findOrCreateRow(sheet, p.title, p.id);
    sheet.getRange(row, COL.ID).setValue(p.id);
    sheet.getRange(row, COL.TITLE).setValue(p.title);
    sheet.getRange(row, COL.SUB).setValue(p.sub);
    sheet.getRange(row, COL.STATUS).setValue(p.status);
    sheet.getRange(row, COL.LAST_UPDATE).setValue(p.lastUpdate);
    sheet.getRange(row, COL.NEXT).setValue(JSON.stringify(p.next));
    sheet.getRange(row, COL.OPEN).setValue(JSON.stringify(p.open));
    sheet.getRange(row, COL.OPEN_REMINDERS).setValue('{}');
    sheet.getRange(row, COL.DOCS).setValue(JSON.stringify(p.docs));
    sheet.getRange(row, COL.STACK).setValue(p.stack);
    sheet.getRange(row, COL.NOTES).setValue('[]');
    sheet.getRange(row, COL.UPDATED_AT).setValue(ts);
  });

  Logger.log('Seeded ' + defaults.length + ' projects into the sheet.');
}

// ── Helpers ──────────────────────────────────────────────────
function ensureHeaders(sheet) {
  var headers = sheet.getRange(1, 1, 1, NUM_COLS).getValues()[0];
  if (headers[0] !== 'id') {
    sheet.getRange(1, 1, 1, NUM_COLS).setValues([[
      'id','title','sub','status','lastUpdate',
      'next','open','openReminders','docs','stack','notes','updatedAt'
    ]]);
    sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight('bold');
  }
}

function findOrCreateRow(sheet, title, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2; // Only header row exists

  var titleCol = sheet.getRange(2, COL.TITLE, lastRow - 1, 1).getValues();
  for (var i = 0; i < titleCol.length; i++) {
    if (titleCol[i][0].toLowerCase() === title.toLowerCase()) {
      return i + 2; // +2 because getValues is 0-indexed and row 1 is header
    }
  }

  // Not found — create new row
  var newRow = lastRow + 1;
  sheet.getRange(newRow, COL.ID).setValue(id || title.toLowerCase().replace(/[^a-z0-9]/g, '-'));
  sheet.getRange(newRow, COL.TITLE).setValue(title);
  sheet.getRange(newRow, COL.STATUS).setValue('active');
  sheet.getRange(newRow, COL.NEXT).setValue('[]');
  sheet.getRange(newRow, COL.OPEN).setValue('[]');
  sheet.getRange(newRow, COL.OPEN_REMINDERS).setValue('{}');
  sheet.getRange(newRow, COL.DOCS).setValue('[]');
  sheet.getRange(newRow, COL.NOTES).setValue('[]');
  return newRow;
}

function getOrCreateArchive(parentFolder) {
  var folders = parentFolder.getFoldersByName(ARCHIVE_NAME);
  if (folders.hasNext()) return folders.next();
  return parentFolder.createFolder(ARCHIVE_NAME);
}

function extractField(content, fieldName) {
  var re = new RegExp('^' + fieldName + ':\\s*(.+)$', 'im');
  var match = content.match(re);
  return match ? match[1].trim() : '';
}

function extractSection(content, sectionName) {
  var re = new RegExp(sectionName + '\\s*[-]*\\s*\\n([\\s\\S]+?)(?=\\n[A-Z][A-Z ]+[—\\-]{1,3}|\\n={3,}|$)', 'i');
  var match = content.match(re);
  if (!match) return '';
  return match[1].trim().replace(/^-+\s*/gm, '').trim();
}

function extractList(content, sectionName) {
  var section = extractSection(content, sectionName);
  if (!section) return [];
  return section.split('\n')
    .map(function(l) { return l.replace(/^[-*•]\s*/, '').trim(); })
    .filter(function(l) { return l.length > 0; });
}

function parseDocs(raw) {
  var docs = [];
  var lines = raw.split('\n');
  var current = {};
  lines.forEach(function(line) {
    var typeMatch = line.match(/^Type:\s*(.+)/i);
    var labelMatch = line.match(/^Label:\s*(.+)/i);
    var urlMatch = line.match(/^URL:\s*(.+)/i);
    if (typeMatch) { if (current.label) docs.push(current); current = { type: typeMatch[1].trim(), label: '', url: '' }; }
    else if (labelMatch && current.type) current.label = labelMatch[1].trim();
    else if (urlMatch && current.type) current.url = urlMatch[1].trim();
  });
  if (current.label) docs.push(current);
  return docs;
}

function safeParseJson(val, fallback) {
  if (!val || val === '') return fallback;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

function taskText(t) {
  return typeof t === 'string' ? t : (t.text || '');
}
