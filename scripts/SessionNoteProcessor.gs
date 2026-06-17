// ============================================================
// Project Registry — Session Note Processor + Web App API
// Auto-deployed via GitHub Actions + clasp v2
// Google Apps Script
//
// SETUP:
// 1. Paste this into script.google.com → New project
// 2. Run seedFromDefaults() once to populate the Sheet
// 3. Run setupTrigger() once to install the 30-min trigger
// 4. Deploy as Web App:
//    Deploy → New deployment → Web app
//    Execute as: Me
//    Who has access: Anyone with the link
//    Copy the Web App URL → paste into Netlify as APPS_SCRIPT_URL
// ============================================================

var SHEET_ID = '1nDPexqypLeC5YFhSFi9ArHJ2lJsucpsm0RcpVeKPzgc';
var FOLDER_ID = '14et5aNovx3id8UH2KSgDDFnXlWP_tRlC';
var ARCHIVE_NAME = 'Archive';
var SECRET = 'reg_' + SHEET_ID.slice(0, 8); // simple shared secret

// Sheet columns (1-indexed)
var COL = {
  ID: 1, TITLE: 2, SUB: 3, STATUS: 4, LAST_UPDATE: 5,
  NEXT: 6, OPEN: 7, OPEN_REMINDERS: 8, DOCS: 9,
  STACK: 10, NOTES: 11, UPDATED_AT: 12
};
var NUM_COLS = 12;
var HEADERS = ['id','title','sub','status','lastUpdate','next','open','openReminders','docs','stack','notes','updatedAt'];
var JSON_FIELDS = ['next','open','openReminders','docs','notes'];

// ── Web App handlers ─────────────────────────────────────────

function doGet(e) {
  try {
    if ((e.parameter.secret || '') !== SECRET) {
      return jsonResponse({error: 'Unauthorized'}, 401);
    }
    // Manual sync trigger
    if (e.parameter.action === 'sync') {
      processUnreadNotes();
      return jsonResponse({ok: true, message: 'Sync complete'});
    }
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    ensureHeaders(sheet);
    var projects = readAllProjects(sheet);
    return jsonResponse(projects);
  } catch(err) {
    return jsonResponse({error: err.message}, 500);
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if ((body.secret || '') !== SECRET) {
      return jsonResponse({error: 'Unauthorized'}, 401);
    }

    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    ensureHeaders(sheet);

    var action = body.action;

    // ── PUT: replace all projects ──
    if (action === 'put') {
      var projects = body.projects;
      var rows = [HEADERS];
      projects.forEach(function(p) {
        rows.push(projectToRow(p));
      });
      // Clear and rewrite
      var lastRow = Math.max(sheet.getLastRow(), 1);
      if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, NUM_COLS).clearContent();
      if (projects.length > 0) {
        sheet.getRange(2, 1, projects.length, NUM_COLS).setValues(rows.slice(1));
      }
      return jsonResponse({ok: true});
    }

    // ── PATCH: upsert single project ──
    if (action === 'patch') {
      var p = body.project;
      var row = findRowById(sheet, p.id);
      if (row > 0) {
        sheet.getRange(row, 1, 1, NUM_COLS).setValues([projectToRow(p)]);
      } else {
        var newRow = Math.max(sheet.getLastRow(), 1) + 1;
        sheet.getRange(newRow, 1, 1, NUM_COLS).setValues([projectToRow(p)]);
      }
      return jsonResponse({ok: true});
    }

    return jsonResponse({error: 'Unknown action'}, 400);
  } catch(err) {
    return jsonResponse({error: err.message}, 500);
  }
}

function jsonResponse(data, code) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ── Sheet helpers ─────────────────────────────────────────────

function readAllProjects(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  return values
    .filter(function(row) { return row[0]; }) // skip empty rows
    .map(function(row) {
      var p = {};
      HEADERS.forEach(function(h, i) {
        if (JSON_FIELDS.indexOf(h) >= 0) {
          try { p[h] = JSON.parse(row[i] || (h === 'openReminders' ? '{}' : '[]')); }
          catch(e) { p[h] = h === 'openReminders' ? {} : []; }
        } else {
          p[h] = row[i] || '';
        }
      });
      return p;
    });
}

function projectToRow(p) {
  return HEADERS.map(function(h) {
    if (JSON_FIELDS.indexOf(h) >= 0) {
      return JSON.stringify(p[h] != null ? p[h] : (h === 'openReminders' ? {} : []));
    }
    return p[h] != null ? p[h] : '';
  });
}

function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, COL.ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

function ensureHeaders(sheet) {
  var first = sheet.getRange(1, 1).getValue();
  if (first !== 'id') {
    sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight('bold');
  }
}

// ── Session note processing ───────────────────────────────────

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processUnreadNotes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processUnreadNotes').timeBased().everyMinutes(30).create();
  Logger.log('Trigger installed: processUnreadNotes every 30 minutes');
}

function processUnreadNotes() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFiles();
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);
  var processed = 0;

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (!name.toLowerCase().includes('sessionnote')) continue; // match any file with SessionNote in name
    if (name.match(/^TEMPLATE_/i)) continue; // skip template file
    if (name.match(/^README/i)) continue; // skip readme
    var content = file.getBlob().getDataAsString();
    if (extractField(content, 'PROCESSED').toLowerCase() === 'yes') continue;
    Logger.log('Processing: ' + name);
    processNote(content, file, sheet);
    processed++;
  }
  Logger.log('Done. Processed ' + processed + ' note(s).');
}

function processNote(content, file, sheet) {
  // Normalise markdown-escaped content from Google Drive MCP conversion
  // Drive MCP escapes characters like \- \= \[ \] \_
  content = content.split('\\-').join('-');
  content = content.split('\\=').join('=');
  content = content.split('\\~').join('~');
  content = content.split('\\[').join('[');
  content = content.split('\\]').join(']');
  content = content.split('\\_').join('_');
  var projectTitle = extractField(content, 'PROJECT');
  // Fallback: extract from "SESSION NOTE — Project Name" title line
  if (!projectTitle) {
    var titleMatch = content.match(/^SESSION NOTE[\s—\-]+(.+)$/im);
    if (titleMatch) projectTitle = titleMatch[1].trim();
  }
  // Fallback: extract from "Date:" line context or filename hint
  if (!projectTitle) {
    var dateLineMatch = content.match(/^(?:Project|For|Re)[:\s]+(.+)$/im);
    if (dateLineMatch) projectTitle = dateLineMatch[1].trim();
  }
  var status = extractField(content, 'STATUS');
  var whatWasDone = extractSection(content, 'WHAT WAS DONE THIS SESSION') || extractSection(content, 'WHAT WAS DONE');
  var nextAdd = extractList(content, 'NEXT ACTIONS — ADD') .concat(extractList(content, 'NEXT ACTIONS (to add)'));
  var nextRemove = extractList(content, 'NEXT ACTIONS — DONE/REMOVE');
  var openAdd = extractList(content, 'OPEN ITEMS — ADD').concat(extractList(content, 'OPEN ITEMS'));
  var openRemove = extractList(content, 'OPEN ITEMS — RESOLVED/REMOVE');
  var docsRaw = extractSection(content, 'DOCUMENTS ADDED') || extractSection(content, 'NEW DOCUMENTS');
  var stackUpdate = extractSection(content, 'STACK / CONTACTS UPDATE');
  var sessionNotes = extractSection(content, 'SESSION NOTES');

  if (!projectTitle) { Logger.log('No PROJECT field — skipping'); return; }

  var row = findOrCreateRow(sheet, projectTitle);

  if (status) sheet.getRange(row, COL.STATUS).setValue(status);
  if (whatWasDone) sheet.getRange(row, COL.LAST_UPDATE).setValue(whatWasDone);
  if (stackUpdate && stackUpdate.length > 2) sheet.getRange(row, COL.STACK).setValue(stackUpdate);

  // Merge next actions
  var nextArr = safeJson(sheet.getRange(row, COL.NEXT).getValue(), []);
  nextAdd.forEach(function(text) {
    if (text && !nextArr.find(function(t) { return taskText(t) === text; }))
      nextArr.push({text: text, dueDate: null, reminderDate: null});
  });
  nextRemove.forEach(function(text) {
    nextArr = nextArr.filter(function(t) { return taskText(t) !== text; });
  });
  sheet.getRange(row, COL.NEXT).setValue(JSON.stringify(nextArr));

  // Merge open items
  var openArr = safeJson(sheet.getRange(row, COL.OPEN).getValue(), []);
  openAdd.forEach(function(item) { if (item && openArr.indexOf(item) < 0) openArr.push(item); });
  openRemove.forEach(function(item) { openArr = openArr.filter(function(x) { return x !== item; }); });
  sheet.getRange(row, COL.OPEN).setValue(JSON.stringify(openArr));

  // Parse and add documents
  if (docsRaw) {
    var newDocs = parseDocs(docsRaw);
    if (newDocs.length > 0) {
      var docsArr = safeJson(sheet.getRange(row, COL.DOCS).getValue(), []);
      newDocs.forEach(function(doc) {
        if (!docsArr.find(function(d) { return d.label === doc.label; })) docsArr.push(doc);
      });
      sheet.getRange(row, COL.DOCS).setValue(JSON.stringify(docsArr));
    }
  }

  // Append session note
  var notesArr = safeJson(sheet.getRange(row, COL.NOTES).getValue(), []);
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');
  var entry = '[' + ts + '] ' + (whatWasDone ? whatWasDone.substring(0, 150) : file.getName());
  if (sessionNotes) entry += ' | ' + sessionNotes.substring(0, 100);
  notesArr.unshift(entry);
  sheet.getRange(row, COL.NOTES).setValue(JSON.stringify(notesArr));
  sheet.getRange(row, COL.UPDATED_AT).setValue(ts);

  // Mark processed and archive
  file.setContent(content.replace(/^PROCESSED:\s*no/im, 'PROCESSED: yes'));
  var archiveFolder = getOrCreateArchive(DriveApp.getFolderById(FOLDER_ID));
  archiveFolder.addFile(file);
  DriveApp.getFolderById(FOLDER_ID).removeFile(file);
  Logger.log('Archived: ' + file.getName() + ' → ' + projectTitle);
}

// ── Seed defaults ─────────────────────────────────────────────

function seedFromDefaults() {
  var defaults = [
    {id:'screencred',title:'ScreenCred',sub:'Family accountability app',status:'active',lastUpdate:'Full module set built: FamilyHub, Tasks, Skills, Audit, Settings, all child screens, CredCoach, 6 themes.',next:[{text:'Move to Claude Code for direct GitHub push',dueDate:null,reminderDate:null},{text:'Wire Supabase backend',dueDate:null,reminderDate:null},{text:'Fix JSX issues in Settings.tsx and Tasks.tsx',dueDate:null,reminderDate:null},{text:'Build child PIN change flow',dueDate:null,reminderDate:null},{text:'Netlify deployment',dueDate:null,reminderDate:null}],open:['Supabase not yet wired','Weekly reset automation not built','No real notifications yet','SkillCred marketplace (Phase 2)'],openReminders:{},docs:[{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/screencred'}],stack:'React / Vite / TypeScript · github.com/mrmalan/screencred',notes:[]},
    {id:'emix-jv',title:'EMIX JV',sub:'4-product JV with SA Lightning',status:'active',lastUpdate:'Pitch deck, HOA, capex model, 4 competitive analyses, financial dashboard all built. Phase 1 capex R3.1–4.4M.',next:[{text:'Confirm Averge SPD transfer price with Gerrit before pitch',dueDate:null,reminderDate:null},{text:'Structure Lectro-Tech equity/draw offer',dueDate:null,reminderDate:null},{text:'Update full business plan',dueDate:null,reminderDate:null},{text:'Submit ExoWeld DG classification',dueDate:null,reminderDate:null},{text:'ID SADC distributors (Zimbabwe + Zambia)',dueDate:null,reminderDate:null}],open:['SPD COGS at 60% is placeholder','Lectro-Tech not yet formally approached','Vermont Sales: bundle as install kit add-on only'],openReminders:{},docs:[{type:'Deck',label:'Averge pitch deck',url:''},{type:'Model',label:'JV capex model',url:''},{type:'Doc',label:'HOA',url:''},{type:'Tool',label:'Financial dashboard',url:''}],stack:'Products: EMIX-CA, LP mast rental, Raycap SPD, ExoWeld · Contact: Jordan Watson +27 12 450 0940',notes:[]},
    {id:'volt',title:'Volt Energy Platform',sub:'SA energy advisory SPA',status:'active',lastUpdate:'Live at volt-energy-platform.netlify.app. Covers 8 tariffs, bill reconstruction, load growth, battery dispatch, IRR heatmap.',next:[{text:'Spin tariff engine into standalone repo',dueDate:null,reminderDate:null},{text:'Expand to 160+ municipalities',dueDate:null,reminderDate:null},{text:'API-first architecture with formal versioning',dueDate:null,reminderDate:null}],open:['Only 8 of 160+ target tariffs covered','Inclining block + TOU support not yet formalised'],openReminders:{},docs:[{type:'Tool',label:'Live app',url:'https://volt-energy-platform.netlify.app'},{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/volt-energy-platform'}],stack:'React + Vite · repo: volt-energy-platform · GitHub: mrmalan',notes:[]},
    {id:'estac-advisory',title:'Estac Energy Advisory',sub:'New advisory platform',status:'building',lastUpdate:'New repo scoped. Build order defined. Strategic pivot: EaaS + battery arbitrage + behind-the-meter.',next:[{text:'Build tariff engine (160+ SA municipalities)',dueDate:null,reminderDate:null},{text:'Load profile engine',dueDate:null,reminderDate:null},{text:'Opportunity analysis module',dueDate:null,reminderDate:null},{text:'Battery dispatch',dueDate:null,reminderDate:null},{text:'EaaS financial model',dueDate:null,reminderDate:null},{text:'Wheeling module',dueDate:null,reminderDate:null}],open:['Not yet started — scoped only'],openReminders:{},docs:[{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/estac-energy-advisory'}],stack:'React + Vite · repo: estac-energy-advisory',notes:[]},
    {id:'solar-yield',title:'Solar Yield Tool',sub:'Pre-feasibility yield calculator',status:'active',lastUpdate:'Live at solar-yield-tool.netlify.app. Yield Profile tab spans years. HelioScope parity backlog prioritised.',next:[{text:'POA transposition (Perez/Hay-Davies GHI→POA)',dueDate:null,reminderDate:null},{text:'Temperature-corrected cell modelling (NOCT)',dueDate:null,reminderDate:null},{text:'Satellite layout + shade analysis',dueDate:null,reminderDate:null}],open:['Items 1+2 highest value for SA commercial pre-feasibility','Google Maps tile proxy not yet built'],openReminders:{},docs:[{type:'Tool',label:'Live app',url:'https://solar-yield-tool.netlify.app'},{type:'Code',label:'GitHub repo',url:'https://github.com/mrmalan/solar-yield-tool'}],stack:'React + Vite · single App.jsx · repo: solar-yield-tool',notes:[]},
    {id:'payyourshare',title:'PayYourShare',sub:'Mobile bill-splitting PWA',status:'active',lastUpdate:'Live at payyourshare.netlify.app. 8-screen flow with Claude vision bill scanning, tip personalisation.',next:[{text:'Diagnose WhatsApp URL shortener runtime issue',dueDate:null,reminderDate:null},{text:'Test pass-the-bill URL sharing end-to-end',dueDate:null,reminderDate:null}],open:['WhatsApp /api/shorten had runtime issues'],openReminders:{},docs:[{type:'Tool',label:'Live app',url:'https://payyourshare.netlify.app'}],stack:'React + Vite + Netlify Functions · Anthropic API (vision)',notes:[]},
    {id:'lps-toolkit',title:'Estac LPS Toolkit',sub:'IEC 62305-3 engineering tools',status:'active',lastUpdate:'Live at earth-mat-tool.netlify.app. Earth mat, soil resistivity, separation distance, air termination, DB designer.',next:[{text:'Add new tools as Gerrit raises requirements',dueDate:null,reminderDate:null}],open:['Primary user is Gerrit — keep in sync'],openReminders:{},docs:[{type:'Tool',label:'Live app',url:'https://earth-mat-tool.netlify.app'}],stack:'React + Vite + Netlify edge function · End user: Gerrit',notes:[]},
    {id:'abap-cmfp',title:'ABAP CMFP Interface',sub:'SAP Retail outbound PO extract',status:'active',lastUpdate:'Complete standards-compliant program ZRPRR_SREA00243CMFP_PO delivered. 4 code objects + integration guide.',next:[{text:'Developer to resolve 8 open items from integration guide',dueDate:null,reminderDate:null},{text:'Confirm SE11 dictionary objects and activation sequence',dueDate:null,reminderDate:null},{text:'Validate against live COR3 data',dueDate:null,reminderDate:null}],open:['8 open items in integration guide for developer to confirm','Not yet tested against live system'],openReminders:{},docs:[],stack:'ABAP OO · SAP Retail COR3/Shoprite · Blue Yonder CMFP',notes:[]},
    {id:'energyduck',title:'EnergyDuck / Eldo',sub:'Energy retail brand + sales partner',status:'hold',lastUpdate:"Duck mascot 'Bill' and brand complete. SolarAfrica and Metronomic NES agreements reviewed.",next:[{text:'Follow up Anuva Projects Phase 1 with Tim Ohlsen',dueDate:null,reminderDate:null},{text:'Monitor SolarAfrica agreement renegotiation',dueDate:null,reminderDate:null}],open:['SolarAfrica: R0.02/kWh pipeline-gated, unilateral deal approval','Metronomic NES: USD-denominated SIP fees, perpetual patent grant-back'],openReminders:{},docs:[],stack:'Brand only · Contact: Tim Ohlsen — tim@eldoenergy.com',notes:[]},
    {id:'sawem',title:'SAWEM / Market School',sub:'Electricity market certification',status:'done',lastUpdate:'3-day training completed 26–28 May 2026. Passed one-attempt certification exam.',next:[{text:'Apply market knowledge to wheeling proposals and EaaS modelling',dueDate:null,reminderDate:null}],open:[],openReminders:{},docs:[],stack:'Key terms: SMP, CfD, BRP, MO, SO, DAM, IDM, SAPP',notes:[]}
  ];

  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeaders(sheet);
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');
  defaults.forEach(function(p) {
    p.updatedAt = ts;
    var row = findOrCreateRow(sheet, p.title, p.id);
    sheet.getRange(row, 1, 1, NUM_COLS).setValues([projectToRow(p)]);
  });
  Logger.log('Seeded ' + defaults.length + ' projects.');
}

// ── Utilities ─────────────────────────────────────────────────

function findOrCreateRow(sheet, title, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var titles = sheet.getRange(2, COL.TITLE, lastRow - 1, 1).getValues();
    for (var i = 0; i < titles.length; i++) {
      if (titles[i][0].toLowerCase() === title.toLowerCase()) return i + 2;
    }
  }
  var newRow = Math.max(lastRow, 1) + 1;
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

function getOrCreateArchive(parent) {
  var f = parent.getFoldersByName(ARCHIVE_NAME);
  return f.hasNext() ? f.next() : parent.createFolder(ARCHIVE_NAME);
}

function extractField(content, name) {
  // Match "NAME: value" or "NAME — value" patterns
  var m = content.match(new RegExp('^[\\-─]*\\s*' + name + '[:\\s—\\-]+(.+)$', 'im'));
  return m ? m[1].trim() : '';
}

function extractSection(content, name) {
  // Normalise content: replace ──── divider lines with a standard marker
  var normalised = content.replace(/^[─=]{4,}\s*$/gm, '###DIVIDER###');

  // Try exact match first (for standard format with full section names)
  var escapedFull = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var patternFull = new RegExp(
    '^' + escapedFull + '[^\n]*\n(?:[-─=]+\n)?([\s\S]+?)(?=\n[A-Z][A-Z &()\/\-—]+(?:\n|\s*[-─=])|\n={3,}|###DIVIDER###|$)',
    'im'
  );
  var mFull = normalised.match(patternFull);
  if (mFull) {
    var text = mFull[1].trim();
    text = text.replace(/###DIVIDER###/g, '').trim();
    text = text.replace(/\n[A-Z][A-Z &()\/\-—]+\s*$/m, '').trim();
    return text.replace(/^[-*•\\]\s*/gm, '').trim();
  }

  // Fallback: loose match for ──── divider format (strip qualifiers)
  var coreName = name
    .replace(/ — ADD$/i, '').replace(/ — DONE\/REMOVE$/i, '').replace(/ — RESOLVED\/REMOVE$/i, '')
    .replace(/ THIS SESSION$/i, '').replace(/ \(to add\)$/i, '');
  var escapedCore = coreName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var patternLoose = new RegExp(
    '###DIVIDER###\n[^\n]*' + escapedCore + '[^\n]*\n###DIVIDER###\n([\s\S]+?)(?=###DIVIDER###|$)',
    'i'
  );
  var mLoose = normalised.match(patternLoose);
  if (!mLoose) return '';
  var text2 = mLoose[1].trim();
  text2 = text2.replace(/###DIVIDER###/g, '').trim();
  return text2.replace(/^[-*•\\]\s*/gm, '').trim();
}

function extractList(content, name) {
  var s = extractSection(content, name);
  if (!s) return [];
  return s.split('\n')
    .map(function(l) { return l.replace(/^[-*•\\\\]\s*/, '').trim(); })
    .filter(function(l) { return l.length > 0 && !l.match(/^[─=]{3,}/); });
}

function extractDocs(content) {
  // Handle both "DOCUMENTS ADDED" and "NEW DOCUMENTS" sections
  var section = extractSection(content, 'DOCUMENTS ADDED') || extractSection(content, 'NEW DOCUMENTS');
  if (!section) return [];
  return parseDocs(section);
}

function parseDocs(raw) {
  var docs = []; var cur = {};
  raw.split('\n').forEach(function(line) {
    var t = line.match(/^Type:\s*(.+)/i);
    var l = line.match(/^Label:\s*(.+)/i);
    var u = line.match(/^URL:\s*(.+)/i);
    if (t) { if (cur.label) docs.push(cur); cur = {type:t[1].trim(),label:'',url:''}; }
    else if (l && cur.type) cur.label = l[1].trim();
    else if (u && cur.type) cur.url = u[1].trim();
    else {
      // Handle bullet format: "- Filename.ext — Description" or "- Label — url"
      var bullet = line.match(/^[-*]\s+(.+)/);
      if (bullet && !cur.type) {
        var text = bullet[1].trim();
        var parts = text.split(/\s+[—\-]+\s+/);
        var label = parts[0].replace(/_/g, ' ').trim();
        if (label.length > 0) {
          var type = 'Doc';
          var extMatch = label.match(/\.([a-z]+)$/i);
          if (extMatch) {
            var e = extMatch[1].toLowerCase();
            if (e === 'xlsx' || e === 'csv') type = 'Model';
            else if (e === 'pptx') type = 'Deck';
            else if (e === 'js' || e === 'ts' || e === 'py' || e === 'gs') type = 'Code';
          }
          docs.push({type: type, label: label, url: ''});
        }
      }
    }
  });
  if (cur.label) docs.push(cur);
  return docs;
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

function taskText(t) { return typeof t === 'string' ? t : (t.text || ''); }
