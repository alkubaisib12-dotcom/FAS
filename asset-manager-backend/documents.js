// documents.js: the document archive. Scanned papers (invoices, contracts, letters…) with their
// details, their files, links to assets, and one search over the details and the words inside
// the scans, in Arabic and English.
//
// Files live in <data folder>\documents: "inbox" holds scans not yet filed under a document,
// "<year>" the filed ones, "removed" the ones taken out (kept, not deleted). They are only ever
// sent to a logged-in user, through GET /documents/files/:fileId.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { readDocumentText, renderPdfPage, pdfPageCount } = require('./documentText');

// Standard types and the code that starts their IDs (INV-2026-0001). A type typed under "Other"
// takes the first 3 letters of its name; an Arabic-only name gives DOC.
const DOCUMENT_TYPES = [
  { name: 'Invoice', code: 'INV', group: 'Purchase' },
  { name: 'Purchase Order', code: 'PO', group: 'Purchase' },
  { name: 'Quotation', code: 'QUO', group: 'Purchase' },
  { name: 'Delivery Note', code: 'DN', group: 'Purchase' },
  { name: 'Contract', code: 'CON', group: 'Contracts' },
  { name: 'License', code: 'LIC', group: 'Contracts' },
  { name: 'Warranty', code: 'WAR', group: 'Contracts' },
  { name: 'Incoming Letter', code: 'INC', group: 'Correspondence' },
  { name: 'Outgoing Letter', code: 'OUT', group: 'Correspondence' },
  { name: 'Memo', code: 'MEM', group: 'Correspondence' },
];

// Scan types accepted, and the extension each is saved with
const FILE_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const FILE_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];
const EXPIRING_DAYS = 90;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ------------------------------ Search text ------------------------------ */
// Arabic is written with letter variants and optional marks, so both the indexed text and the
// search are reduced to one form: no harakat or tatweel, أ/إ/آ → ا, ة → ه, ى → ي, ؤ → و, ئ → ي,
// Arabic-Indic digits → 0-9, lower case.
function normalizeChar(c) {
  const code = c.charCodeAt(0);
  if ((code >= 0x064B && code <= 0x0652) || code === 0x0670 || code === 0x0640) return '';
  if (code === 0x0622 || code === 0x0623 || code === 0x0625 || code === 0x0671) return 'ا';
  if (code === 0x0629) return 'ه';
  if (code === 0x0649 || code === 0x0626) return 'ي';
  if (code === 0x0624) return 'و';
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
  return c.toLowerCase();
}

function normalizeForSearch(text) {
  let out = '';
  for (const c of String(text || '')) out += normalizeChar(c);
  return out;
}

// The normalized text, and for each of its characters the index it came from in the original
const normalizeWithMap = (text) => {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const n = normalizeChar(text[i]);
    for (let k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
  }
  return { out, map };
};

const searchTokens = (search) =>
  normalizeForSearch(search).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);

// Every word must appear, each as the start of a word ("فاتور" finds "فاتورة")
const ftsQuery = (search) => {
  const tokens = searchTokens(search);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
};

// Where the search first appears in the scanned text, with some words around it
function snippetFor(fileText, search, radius = 80) {
  if (!fileText) return null;
  const tokens = searchTokens(search);
  if (!tokens.length) return null;
  const { out, map } = normalizeWithMap(fileText);
  let best = -1;
  let len = 0;
  for (const t of tokens) {
    const i = out.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; }
  }
  if (best < 0) return null;
  const start = map[best];
  const end = map[best + len - 1] + 1;
  const from = Math.max(0, start - radius);
  const to = Math.min(fileText.length, end + radius);
  const flat = (s) => s.replace(/\s+/g, ' ');
  return {
    before: (from > 0 ? '…' : '') + flat(fileText.slice(from, start)),
    match: fileText.slice(start, end),
    after: flat(fileText.slice(end, to)) + (to < fileText.length ? '…' : ''),
  };
}

/* ------------------------------ Small helpers ------------------------------ */
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(`${v}T00:00:00Z`));
const text = (v, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const csv = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function canonicalType(type) {
  const t = text(type, 80);
  if (!t) return null;
  const std = DOCUMENT_TYPES.find((x) => x.name.toLowerCase() === t.toLowerCase());
  return std ? std.name : t;
}

function typeCode(type) {
  const std = DOCUMENT_TYPES.find((x) => x.name === type);
  if (std) return std.code;
  return String(type || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'DOC';
}

// No later than the end date, no earlier than the start: "active", "expiring" (within 90 days),
// "expired", or "none" for a document without an end date
function statusOf(doc, today) {
  if (!doc.endDate) return 'none';
  if (doc.endDate < today) return 'expired';
  if (doc.endDate <= addDays(today, EXPIRING_DAYS)) return 'expiring';
  return 'active';
}

// Multer writes the name of an uploaded file as Latin-1; an Arabic file name needs reading as UTF-8
function originalName(file) {
  const raw = file.originalname || 'scan';
  if (/[^\u0000-ÿ]/.test(raw)) return raw;
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return utf8.includes('�') ? raw : utf8;
}

// The document details from a request body, checked. Throws HttpError(400) when something is wrong.
function cleanDetails(body) {
  const d = {
    type: canonicalType(body.type),
    subject: text(body.subject, 300),
    docDate: body.docDate,
    referenceNo: text(body.referenceNo, 120),
    party: text(body.party, 200),
    department: text(body.department, 200),
    amount: body.amount === '' || body.amount === null || body.amount === undefined ? null : Number(body.amount),
    currency: text(body.currency, 10) || 'BHD',
    startDate: text(body.startDate, 10),
    endDate: text(body.endDate, 10),
    keywords: text(body.keywords, 500),
    notes: text(body.notes, 5000),
    paperLocation: text(body.paperLocation, 200),
  };
  if (!d.type) throw new HttpError(400, 'Choose the document type');
  if (!d.subject) throw new HttpError(400, 'Enter the subject');
  if (!isDate(d.docDate)) throw new HttpError(400, 'Enter the document date');
  if (d.amount !== null && !Number.isFinite(d.amount)) throw new HttpError(400, 'The amount must be a number');
  if (d.startDate && !isDate(d.startDate)) throw new HttpError(400, 'The start date is not a valid date');
  if (d.endDate && !isDate(d.endDate)) throw new HttpError(400, 'The end date is not a valid date');
  if (d.startDate && d.endDate && d.endDate < d.startDate) throw new HttpError(400, 'The end date is before the start date');
  return d;
}

const DETAIL_COLUMNS = ['type', 'subject', 'docDate', 'referenceNo', 'party', 'department', 'amount', 'currency',
  'startDate', 'endDate', 'keywords', 'notes', 'paperLocation'];

/* --------------------------------- Routes --------------------------------- */
function registerDocumentRoutes(app, { db, documentsDir, tessdataDir, logAudit }) {
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  const inboxDir = path.join(documentsDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const absPath = (storedName) => path.join(documentsDir, storedName);
  const userOf = (req) => req.session?.user?.email || 'system';

  // Async route with errors turned into JSON answers
  const h = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!e.status) console.error('Archive error:', e);
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
    }
  };

  /* ---- Tables (created in order; see the db.serialize note in index.js) ---- */
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS documents (
      rowKey INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      docDate TEXT NOT NULL,
      referenceNo TEXT,
      party TEXT,
      department TEXT,
      amount REAL,
      currency TEXT,
      startDate TEXT,
      endDate TEXT,
      keywords TEXT,
      notes TEXT,
      paperLocation TEXT,
      archived INTEGER DEFAULT 0,
      createdBy TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_documents_docDate ON documents(docDate)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_documents_endDate ON documents(endDate)`);
    db.run(`CREATE TABLE IF NOT EXISTS document_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId TEXT,
      storedName TEXT NOT NULL,
      originalName TEXT,
      mimeType TEXT,
      size INTEGER,
      pages INTEGER,
      sortOrder INTEGER DEFAULT 0,
      textStatus TEXT DEFAULT 'pending',
      textMethod TEXT,
      textContent TEXT,
      textError TEXT,
      removed INTEGER DEFAULT 0,
      uploadedBy TEXT,
      uploadedAt TEXT DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_document_files_documentId ON document_files(documentId)`);
    db.run(`CREATE TABLE IF NOT EXISTS document_assets (
      documentId TEXT NOT NULL,
      assetId TEXT NOT NULL,
      PRIMARY KEY (documentId, assetId)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_document_assets_assetId ON document_assets(assetId)`);
    // Search index: rowid = documents.rowKey; body is the normalized details and scan text,
    // filetext the scan text as read, for showing where a search word was found
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      body, filetext UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
    // Text reading stopped by a restart starts again
    db.run(`UPDATE document_files SET textStatus = 'pending' WHERE textStatus = 'reading'`);
  });

  /* ---- Search index ---- */
  async function refreshSearch(docId) {
    const d = await get('SELECT * FROM documents WHERE id = ?', [docId]);
    if (!d) return;
    const files = await all(
      'SELECT originalName, textContent FROM document_files WHERE documentId = ? AND removed = 0 ORDER BY sortOrder, id',
      [docId]);
    const assets = await all('SELECT assetId FROM document_assets WHERE documentId = ?', [docId]);
    const details = [d.id, d.type, d.subject, d.referenceNo, d.party, d.department, d.keywords, d.notes,
      d.paperLocation, d.docDate, d.startDate, d.endDate, d.amount,
      ...assets.map((a) => a.assetId), ...files.map((f) => f.originalName)]
      .filter((v) => v !== null && v !== undefined && v !== '')
      .join('\n');
    const fileText = files.map((f) => f.textContent || '').filter(Boolean).join('\n\n');
    await run('INSERT OR REPLACE INTO documents_fts (rowid, body, filetext) VALUES (?, ?, ?)',
      [d.rowKey, normalizeForSearch(`${details}\n${fileText}`), fileText]);
  }

  /* ---- Reading the text of scans, one at a time in the background ---- */
  let reading = false;
  async function readPendingText() {
    if (reading) return;
    reading = true;
    try {
      for (;;) {
        const f = await get(
          `SELECT * FROM document_files WHERE textStatus = 'pending' AND removed = 0 ORDER BY id LIMIT 1`);
        if (!f) break;
        await run(`UPDATE document_files SET textStatus = 'reading' WHERE id = ?`, [f.id]);
        try {
          const result = await readDocumentText(absPath(f.storedName), f.mimeType, { cachePath: tessdataDir });
          await run(
            `UPDATE document_files SET textStatus = ?, textMethod = ?, textContent = ?, pages = ?, textError = NULL WHERE id = ?`,
            [result.text ? 'done' : 'none', result.method, result.text.slice(0, 1000000), result.pages, f.id]);
        } catch (e) {
          console.error(`Archive: could not read the text of file ${f.id}:`, e.message);
          await run(`UPDATE document_files SET textStatus = 'failed', textError = ? WHERE id = ?`,
            [String(e.message).slice(0, 500), f.id]);
        }
        // The scan may have been filed under a document while it was being read
        const now = await get('SELECT documentId FROM document_files WHERE id = ?', [f.id]);
        if (now?.documentId) await refreshSearch(now.documentId);
      }
    } catch (e) {
      console.error('Archive: text reading stopped:', e.message);
    } finally {
      reading = false;
    }
  }
  const startReading = () => { readPendingText(); };
  setTimeout(startReading, 5000).unref();

  /* ---- Uploads ---- */
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, inboxDir),
      filename: (req, file, cb) =>
        cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${FILE_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 50 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (FILE_TYPES[file.mimetype] && FILE_EXTENSIONS.includes(ext)) return cb(null, true);
      cb(new HttpError(400, `Only PDF, JPG and PNG scans can be added: ${originalName(file)} is not one`));
    },
  });

  const receiveFiles = (req, res) => new Promise((resolve, reject) => {
    upload.array('files', 50)(req, res, (err) => {
      if (!err) return resolve(req.files || []);
      if (err.status) return reject(err);
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'A scan is larger than 50 MB'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Add at most 50 scans at a time' : err.message;
      reject(new HttpError(400, message));
    });
  });

  // Saves the uploaded files as unfiled scans ("To file") and returns their rows
  async function recordUploads(files, req) {
    const ids = [];
    for (const file of files) {
      const r = await run(
        `INSERT INTO document_files (documentId, storedName, originalName, mimeType, size, uploadedBy) VALUES (NULL, ?, ?, ?, ?, ?)`,
        [`inbox/${file.filename}`, originalName(file), file.mimetype, file.size, userOf(req)]);
      ids.push(r.lastID);
    }
    startReading();
    return ids;
  }

  // Moves unfiled scans under a document: <year>\<doc id>-<file id>.<ext>
  async function attachFiles(docId, docDate, fileIds) {
    const year = String(docDate).slice(0, 4);
    const last = await get('SELECT MAX(sortOrder) AS n FROM document_files WHERE documentId = ?', [docId]);
    let order = (last?.n || 0) + 1;
    const attached = [];
    for (const fileId of fileIds) {
      const f = await get('SELECT * FROM document_files WHERE id = ? AND documentId IS NULL AND removed = 0', [fileId]);
      if (!f) continue;
      const storedName = `${year}/${docId}-${f.id}${path.extname(f.storedName)}`;
      await fs.promises.mkdir(path.join(documentsDir, year), { recursive: true });
      await fs.promises.rename(absPath(f.storedName), absPath(storedName));
      await run('UPDATE document_files SET documentId = ?, storedName = ?, sortOrder = ? WHERE id = ?',
        [docId, storedName, order++, f.id]);
      attached.push(f.id);
    }
    return attached;
  }

  // A scan taken out is moved to "removed", not deleted, so it can be brought back by hand
  async function removeFile(f) {
    const storedName = `removed/${path.basename(f.storedName)}`;
    await fs.promises.mkdir(path.join(documentsDir, 'removed'), { recursive: true });
    try {
      await fs.promises.rename(absPath(f.storedName), absPath(storedName));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await run('UPDATE document_files SET removed = 1, storedName = ? WHERE id = ?', [storedName, f.id]);
  }

  async function setAssets(docId, assetIds) {
    const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((a) => String(a).trim()).filter(Boolean))];
    await run('DELETE FROM document_assets WHERE documentId = ?', [docId]);
    for (const assetId of ids) {
      await run('INSERT OR IGNORE INTO document_assets (documentId, assetId) VALUES (?, ?)', [docId, assetId]);
    }
  }

  const fileRow = (f) => ({
    id: f.id, documentId: f.documentId, originalName: f.originalName, mimeType: f.mimeType, size: f.size,
    pages: f.pages, textStatus: f.textStatus, textMethod: f.textMethod, textError: f.textError,
    uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt, sortOrder: f.sortOrder,
  });

  /* ---- Reference lists ---- */
  app.get('/documents/types', h(async (req, res) => {
    const used = await all('SELECT DISTINCT type FROM documents ORDER BY type COLLATE NOCASE');
    const custom = used.map((r) => r.type).filter((t) => !DOCUMENT_TYPES.some((x) => x.name === t));
    res.json([...DOCUMENT_TYPES, ...custom.map((name) => ({ name, code: typeCode(name), group: 'Other' }))]);
  }));

  app.get('/documents/filter-options', h(async (req, res) => {
    const where = req.query.includeArchived === '1' ? '' : 'WHERE COALESCE(archived, 0) = 0';
    const distinct = async (expr) => (await all(
      `SELECT DISTINCT ${expr} AS v FROM documents ${where} ${where ? 'AND' : 'WHERE'} ${expr} IS NOT NULL AND TRIM(${expr}) <> '' ORDER BY v COLLATE NOCASE`))
      .map((r) => r.v);
    res.json({
      types: await distinct('type'),
      years: (await distinct('substr(docDate, 1, 4)')).sort().reverse(),
      parties: await distinct('party'),
      departments: await distinct('department'),
    });
  }));

  // Preview of the next ID for a type and date: INV-2026-0004. The number is taken when saving.
  app.get('/documents/next-id', h(async (req, res) => {
    const type = canonicalType(req.query.type);
    const date = isDate(req.query.date) ? req.query.date : localDate();
    if (!type) throw new HttpError(400, 'type is required');
    const prefix = `${typeCode(type)}-${date.slice(0, 4)}`;
    const row = await get(
      `SELECT COALESCE(MAX(CAST(substr(id, ?) AS INTEGER)), 0) + 1 AS n FROM documents WHERE id GLOB ?`,
      [prefix.length + 2, `${prefix}-[0-9]*`]);
    res.json({ id: `${prefix}-${String(row.n).padStart(4, '0')}` });
  }));

  /* ---- Unfiled scans ("To file") ---- */
  app.get('/documents/inbox', h(async (req, res) => {
    const rows = await all('SELECT * FROM document_files WHERE documentId IS NULL AND removed = 0 ORDER BY id');
    res.json(rows.map(fileRow));
  }));

  app.post('/documents/inbox', h(async (req, res) => {
    const files = await receiveFiles(req, res);
    if (!files.length) throw new HttpError(400, 'Choose at least one scan');
    const ids = await recordUploads(files, req);
    logAudit(req, 'document.scans_uploaded', 'document', '', { count: ids.length });
    const rows = await all(`SELECT * FROM document_files WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    res.status(201).json(rows.map(fileRow));
  }));

  app.delete('/documents/inbox/:fileId', h(async (req, res) => {
    const f = await get('SELECT * FROM document_files WHERE id = ? AND documentId IS NULL AND removed = 0', [req.params.fileId]);
    if (!f) throw new HttpError(404, 'Scan not found in To file');
    await removeFile(f);
    logAudit(req, 'document.scan_discarded', 'document', '', { fileId: f.id, name: f.originalName });
    res.json({ removed: true });
  }));

  /* ---- Files ---- */
  app.get('/documents/files/:fileId', h(async (req, res) => {
    const f = await get('SELECT * FROM document_files WHERE id = ? AND removed = 0', [req.params.fileId]);
    if (!f || !FILE_TYPES[f.mimeType]) throw new HttpError(404, 'File not found');
    const name = encodeURIComponent(f.originalName || `scan${FILE_TYPES[f.mimeType]}`);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`);
    res.sendFile(absPath(f.storedName), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File not found on disk' });
    });
  }));

  // How many pages a scan has (a JPG or PNG is one page)
  app.get('/documents/files/:fileId/meta', h(async (req, res) => {
    const f = await get('SELECT * FROM document_files WHERE id = ? AND removed = 0', [req.params.fileId]);
    if (!f) throw new HttpError(404, 'File not found');
    let pages = f.pages;
    if (!pages) {
      pages = f.mimeType === 'application/pdf' ? await pdfPageCount(absPath(f.storedName)) : 1;
      await run('UPDATE document_files SET pages = ? WHERE id = ?', [pages, f.id]);
    }
    res.json({ id: f.id, pages, mimeType: f.mimeType });
  }));

  // One page of a scan as a PNG image, ?w=<pixels wide>. Browsers on iPads (and some others)
  // can't show a PDF inside a page, so previews and thumbnails use these images. Rendered pages
  // are kept in documents\previews; a JPG or PNG scan is sent as it is.
  app.get('/documents/files/:fileId/pages/:n', h(async (req, res) => {
    const f = await get('SELECT * FROM document_files WHERE id = ? AND removed = 0', [req.params.fileId]);
    if (!f) throw new HttpError(404, 'File not found');
    const n = Math.max(1, parseInt(req.params.n, 10) || 1);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (f.mimeType !== 'application/pdf') {
      if (n !== 1) throw new HttpError(404, 'Page not found');
      res.setHeader('Content-Type', f.mimeType);
      return res.sendFile(absPath(f.storedName));
    }
    const width = Math.min(1600, Math.max(200, Math.round((parseInt(req.query.w, 10) || 1100) / 100) * 100));
    const cached = path.join(documentsDir, 'previews', `${f.id}-p${n}-w${width}.png`);
    if (!fs.existsSync(cached)) {
      const { pages, png } = await renderPdfPage(absPath(f.storedName), n, width);
      if (!f.pages) await run('UPDATE document_files SET pages = ? WHERE id = ?', [pages, f.id]);
      if (!png) throw new HttpError(404, 'Page not found');
      await fs.promises.mkdir(path.dirname(cached), { recursive: true });
      await fs.promises.writeFile(cached, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(cached);
  }));

  app.post('/documents/files/:fileId/read-text', h(async (req, res) => {
    const r = await run(`UPDATE document_files SET textStatus = 'pending', textError = NULL WHERE id = ? AND removed = 0`, [req.params.fileId]);
    if (r.changes === 0) throw new HttpError(404, 'File not found');
    startReading();
    res.json({ queued: true });
  }));

  /* ---- Expiring contracts, licenses and warranties (for the Dashboard) ---- */
  app.get('/documents/expiring', h(async (req, res) => {
    const today = isDate(req.query.today) ? req.query.today : localDate();
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || EXPIRING_DAYS));
    const rows = await all(
      `SELECT id, type, subject, party, endDate FROM documents
       WHERE COALESCE(archived, 0) = 0 AND endDate IS NOT NULL AND endDate <> '' AND endDate <= ?
       ORDER BY endDate`,
      [addDays(today, days)]);
    const withDays = rows.map((r) => ({
      ...r, daysLeft: Math.round((new Date(`${r.endDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000),
    }));
    res.json({ expiring: withDays.filter((r) => r.daysLeft >= 0), expired: withDays.filter((r) => r.daysLeft < 0) });
  }));

  /* ---- Documents linked to an asset (for the asset page) ---- */
  app.get('/assets/:assetId/documents', h(async (req, res) => {
    const rows = await all(
      `SELECT d.id, d.type, d.subject, d.docDate, d.party,
              (SELECT f.id FROM document_files f WHERE f.documentId = d.id AND f.removed = 0 ORDER BY f.sortOrder, f.id LIMIT 1) AS firstFileId
       FROM document_assets da JOIN documents d ON d.id = da.documentId
       WHERE da.assetId = ? AND COALESCE(d.archived, 0) = 0
       ORDER BY d.docDate DESC`,
      [req.params.assetId]);
    res.json(rows);
  }));

  /* ---- The archive list: search, filters, pages ---- */
  // page>0 → { items, total, page, pageSize }; page=0 → every match as an array (for Excel, up to 10,000).
  // Filters are comma-separated lists: type, year, party, department, status (active|expiring|expired|none).
  app.get('/documents', h(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 0;
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const today = isDate(req.query.today) ? req.query.today : localDate();
    const search = String(req.query.search || '').trim();
    const match = search ? ftsQuery(search) : null;

    const where = [];
    const params = [];
    if (req.query.includeArchived !== '1') where.push('COALESCE(d.archived, 0) = 0');
    if (search) {
      if (!match) return res.json(page > 0 ? { items: [], total: 0, page, pageSize } : []);
      where.push('d.rowKey IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)');
      params.push(match);
    }
    const inList = (expr, values) => {
      if (!values.length) return;
      where.push(`${expr} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    inList('d.type', csv(req.query.type));
    inList('substr(d.docDate, 1, 4)', csv(req.query.year));
    inList('d.party', csv(req.query.party));
    inList('d.department', csv(req.query.department));
    const statuses = csv(req.query.status);
    if (statuses.length) {
      const soon = addDays(today, EXPIRING_DAYS);
      const conds = [];
      if (statuses.includes('none')) conds.push(`(d.endDate IS NULL OR d.endDate = '')`);
      if (statuses.includes('expired')) { conds.push(`(d.endDate <> '' AND d.endDate < ?)`); params.push(today); }
      if (statuses.includes('expiring')) { conds.push(`(d.endDate >= ? AND d.endDate <= ?)`); params.push(today, soon); }
      if (statuses.includes('active')) { conds.push(`(d.endDate > ?)`); params.push(soon); }
      if (conds.length) where.push(`(${conds.join(' OR ')})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = await get(`SELECT COUNT(*) AS total FROM documents d ${whereSql}`, params);
    const limit = page > 0 ? pageSize : 10000;
    const offset = page > 0 ? (page - 1) * pageSize : 0;
    const rows = await all(
      `SELECT d.*,
         (SELECT COUNT(*) FROM document_files f WHERE f.documentId = d.id AND f.removed = 0) AS fileCount,
         (SELECT f.id FROM document_files f WHERE f.documentId = d.id AND f.removed = 0 ORDER BY f.sortOrder, f.id LIMIT 1) AS firstFileId,
         (SELECT COUNT(*) FROM document_files f WHERE f.documentId = d.id AND f.removed = 0 AND f.textStatus IN ('pending', 'reading')) AS readingCount,
         (SELECT GROUP_CONCAT(assetId, ', ') FROM document_assets a WHERE a.documentId = d.id) AS assetIds
         ${search ? ', (SELECT filetext FROM documents_fts WHERE rowid = d.rowKey) AS fileText' : ''}
       FROM documents d ${whereSql}
       ORDER BY d.docDate DESC, d.rowKey DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]);

    const items = rows.map(({ fileText, rowKey, ...d }) => ({
      ...d,
      archived: Boolean(d.archived),
      status: statusOf(d, today),
      snippet: search ? snippetFor(fileText, search) : null,
    }));
    res.json(page > 0 ? { items, total, page, pageSize } : items);
  }));

  /* ---- One document ---- */
  app.get('/documents/:id', h(async (req, res) => {
    const d = await get('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!d) throw new HttpError(404, 'Document not found');
    const files = await all('SELECT * FROM document_files WHERE documentId = ? AND removed = 0 ORDER BY sortOrder, id', [d.id]);
    const assets = await all(
      `SELECT da.assetId, a.assetType, a.brandModel, a.serialNumber, a.assignedTo
       FROM document_assets da LEFT JOIN assets a ON a.assetId = da.assetId
       WHERE da.documentId = ? ORDER BY da.assetId`,
      [d.id]);
    const { rowKey, ...doc } = d;
    res.json({ ...doc, archived: Boolean(d.archived), status: statusOf(d, localDate()), files: files.map(fileRow), assets });
  }));

  // New document. The ID is chosen in the same INSERT: the next number for its type and the
  // year of its date, so two people saving at the same moment cannot get the same ID.
  app.post('/documents', h(async (req, res) => {
    const d = cleanDetails(req.body || {});
    const fileIds = (Array.isArray(req.body.fileIds) ? req.body.fileIds : []).map(Number).filter(Number.isInteger);
    const prefix = `${typeCode(d.type)}-${d.docDate.slice(0, 4)}`;
    const row = await get(
      `INSERT INTO documents (id, ${DETAIL_COLUMNS.join(', ')}, createdBy)
       SELECT ? || '-' || printf('%04d', (SELECT COALESCE(MAX(CAST(substr(id, ?) AS INTEGER)), 0) + 1 FROM documents WHERE id GLOB ?)),
              ${DETAIL_COLUMNS.map(() => '?').join(', ')}, ?
       RETURNING id`,
      [prefix, prefix.length + 2, `${prefix}-[0-9]*`, ...DETAIL_COLUMNS.map((c) => d[c]), userOf(req)]);
    const attached = await attachFiles(row.id, d.docDate, fileIds);
    await setAssets(row.id, req.body.assetIds);
    await refreshSearch(row.id);
    logAudit(req, 'document.created', 'document', row.id, { type: d.type, subject: d.subject, files: attached.length });
    res.status(201).json({ id: row.id, files: attached.length });
  }));

  // Edit details and linked assets. The ID stays, even if the type or the year changes.
  app.put('/documents/:id', h(async (req, res) => {
    const d = cleanDetails(req.body || {});
    const r = await run(
      `UPDATE documents SET ${DETAIL_COLUMNS.map((c) => `${c} = ?`).join(', ')}, updatedAt = datetime('now') WHERE id = ?`,
      [...DETAIL_COLUMNS.map((c) => d[c]), req.params.id]);
    if (r.changes === 0) throw new HttpError(404, 'Document not found');
    if (Array.isArray(req.body.assetIds)) await setAssets(req.params.id, req.body.assetIds);
    await refreshSearch(req.params.id);
    logAudit(req, 'document.updated', 'document', req.params.id, { subject: d.subject });
    res.json({ updated: true });
  }));

  // "Delete" archives: the document leaves the list but keeps its details and scans
  app.delete('/documents/:id', h(async (req, res) => {
    const r = await run(`UPDATE documents SET archived = 1, updatedAt = datetime('now') WHERE id = ?`, [req.params.id]);
    if (r.changes === 0) throw new HttpError(404, 'Document not found');
    logAudit(req, 'document.archived', 'document', req.params.id, {});
    res.json({ archived: true });
  }));

  app.post('/documents/:id/restore', h(async (req, res) => {
    const r = await run(`UPDATE documents SET archived = 0, updatedAt = datetime('now') WHERE id = ?`, [req.params.id]);
    if (r.changes === 0) throw new HttpError(404, 'Document not found');
    logAudit(req, 'document.restored', 'document', req.params.id, {});
    res.json({ restored: true });
  }));

  // More scans for a document: uploaded files, and/or unfiled scans by id (fileIds, comma-separated)
  app.post('/documents/:id/files', h(async (req, res) => {
    const d = await get('SELECT id, docDate FROM documents WHERE id = ?', [req.params.id]);
    if (!d) throw new HttpError(404, 'Document not found');
    const uploaded = await receiveFiles(req, res);
    const newIds = await recordUploads(uploaded, req);
    const fromInbox = csv(req.body?.fileIds).map(Number).filter(Number.isInteger);
    const attached = await attachFiles(d.id, d.docDate, [...newIds, ...fromInbox]);
    if (!attached.length) throw new HttpError(400, 'Choose at least one scan');
    await refreshSearch(d.id);
    logAudit(req, 'document.files_added', 'document', d.id, { count: attached.length });
    res.status(201).json({ attached: attached.length });
  }));

  app.delete('/documents/:id/files/:fileId', h(async (req, res) => {
    const f = await get('SELECT * FROM document_files WHERE id = ? AND documentId = ? AND removed = 0', [req.params.fileId, req.params.id]);
    if (!f) throw new HttpError(404, 'File not found');
    await removeFile(f);
    await refreshSearch(req.params.id);
    logAudit(req, 'document.file_removed', 'document', req.params.id, { fileId: f.id, name: f.originalName });
    res.json({ removed: true });
  }));
}

module.exports = { registerDocumentRoutes, normalizeForSearch, DOCUMENT_TYPES };
