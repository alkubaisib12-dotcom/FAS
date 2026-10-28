// index.js — Express + SQLite + LDAP auth + sessions + protected routes
// + token-gated fingerprints + MAC/IP normalization + duplicate-skip logic

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const ldap = require('ldapjs');
const multer = require('multer');
const { resolveDataPaths, checkDataDir } = require('./dataDir');
const { registerDocumentRoutes } = require('./documents');

/* ── OCR (tesseract.js) — optional; degrades gracefully if not installed ── */
let _tesseractCreateWorker = null;
try {
  _tesseractCreateWorker = require('tesseract.js').createWorker;
} catch { /* OCR disabled */ }

const TESSDATA_DIR = path.resolve(__dirname, 'tessdata');
fs.mkdirSync(TESSDATA_DIR, { recursive: true });

async function ocrImage(filePath) {
  if (!_tesseractCreateWorker) return '';
  try {
    const worker = await _tesseractCreateWorker('eng', 1, {
      cachePath: TESSDATA_DIR,
      logger: () => {}
    });
    const { data: { text } } = await worker.recognize(filePath);
    await worker.terminate();
    return text.replace(/\s+/g, ' ').trim();
  } catch (e) {
    console.error('OCR error:', e.message);
    return '';
  }
}

const app = express();
const PORT = Number(process.env.PORT || 4000);
const SCAN_TOKEN = process.env.SCAN_TOKEN || '';

// Accept scanner token via X-Scan-Token or Authorization: Bearer <token>
function hasScanToken(req) {
  if (!SCAN_TOKEN) return false;
  const x = req.get('X-Scan-Token') || '';
  const auth = req.get('Authorization') || '';
  return x === SCAN_TOKEN || auth === `Bearer ${SCAN_TOKEN}`;
}

/* --------------------------- Config / Defaults --------------------------- */
// CORS origins (comma separated) — normalize: lowercase + strip trailing slash
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://10.27.17.20:3100,http://localhost:3100,http://127.0.0.1:3100')
  .split(',')
  .map(s => (s || '').trim().toLowerCase().replace(/\/$/, ''))
  .filter(Boolean);

const normalizeOrigin = v => (v || '').toLowerCase().replace(/\/$/, '');

// Allow any origin coming from a private-network IP (10.x, 172.16-31.x, 192.168.x)
// so the app keeps working when the server changes IP / SSID without needing a redeploy.
function isPrivateNetworkOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      !host.includes('.')   // single-label hostname = intranet (e.g. swdapp, server)
    );
  } catch {
    return false;
  }
}

// LDAP (meeting-app style)
const LDAP_URL = process.env.LDAP_URL || 'ldap://10.27.16.5';
const LDAP_BASE_DN = process.env.LDAP_BASE_DN || 'DC=swd,DC=local';
const LDAP_DEFAULT_UPN = process.env.LDAP_DEFAULT_UPN || 'swd.bh';
const LDAP_ALT_UPN = process.env.LDAP_ALT_UPN || 'swd.local';
const LDAP_NETBIOS = process.env.LDAP_NETBIOS || 'SWD';

// Session
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_long_random_string';

// Allow-list (ONLY these emails may log in)
const allowedEmails = new Set(
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

function isAllowedEmailOrUsername(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (allowedEmails.has(e)) return true;
  const local = e.split('@')[0];
  for (const allowed of allowedEmails) {
    const allowedLocal = allowed.split('@')[0];
    if (allowedLocal === local) return true;
  }
  return false;
}

/* --------------------------- Middleware (top) ---------------------------- */
// ---- CORS (normalized) ----
const corsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server or tools with no Origin header
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(normalizeOrigin(origin))) return cb(null, true);
    // allow any private-network origin so the app works across IP/SSID changes
    if (isPrivateNetworkOrigin(origin)) return cb(null, true);
    return cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Scan-Token'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Preflight handler compatible with path-to-regexp v7+: use regex, not '*'
app.options(/.*/, cors(corsOptions));

app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));

/* ------------------------------ SQLite ---------------------------------- */
// assets.db and uploads live in DATA_DIR when .env sets it (see dataDir.js), else in this folder.
// Checked before opening: sqlite3 would quietly create a new empty assets.db in a wrong DATA_DIR.
const dataPaths = resolveDataPaths();
const dataCheck = checkDataDir(dataPaths);
dataCheck.warnings.forEach(w => console.warn(`WARNING: ${w}`));
if (dataCheck.error) {
  console.error(dataCheck.error);
  process.exit(1);
}

const dbPath = dataPaths.dbPath;
const db = new sqlite3.Database(dbPath);

// Wait up to 5 s for a lock instead of node-sqlite3's default 1 s. The backup tool reads
// assets.db just before each server backup run, and a write that meets its read lock for longer than
// the timeout fails with SQLITE_BUSY. Several writes here have no callback (session pruning,
// used_ids, the rename transaction), and an error on those was an unhandled 'error' event that
// ended the whole process (see the db.run wrapper below). 5 s lets such a write simply wait.
db.configure('busyTimeout', 5000);

// Any db.run without a callback that fails emits an 'error' event nobody listens to, and Node then
// ends the whole process: one failed statement (a BEGIN meeting another request's open transaction,
// a lock held past the timeout) took FAS down for everyone. Give each such call a callback that
// logs the failure instead. Calls that pass their own callback are unchanged.
const dbRun = db.run.bind(db);
db.run = function (sql, ...args) {
  if (typeof args[args.length - 1] !== 'function') {
    args.push((err) => {
      if (err) console.error(`DB error in "${String(sql).trim().split(/\s+/).slice(0, 4).join(' ')} ...": ${err.message}`);
    });
  }
  return dbRun(sql, ...args);
};

// Enable FK so ON DELETE CASCADE works
db.run('PRAGMA foreign_keys = ON');

/* ---- SQLite-backed session store (survives server restarts) ---- */
class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this._db = db;
    this._db.run(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
    // Prune expired sessions every 15 minutes
    setInterval(() => {
      this._db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]);
    }, 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    this._db.get('SELECT data, expires FROM sessions WHERE sid = ?', [sid], (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this._db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
        return cb(null, null);
      }
      try { cb(null, JSON.parse(row.data)); } catch (e) { cb(e); }
    });
  }
  set(sid, sess, cb) {
    const maxAge = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge : 7 * 24 * 60 * 60 * 1000;
    const expires = Date.now() + maxAge;
    const data = JSON.stringify(sess);
    this._db.run(
      'INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)',
      [sid, data, expires],
      cb || (() => {})
    );
  }
  destroy(sid, cb) {
    this._db.run('DELETE FROM sessions WHERE sid = ?', [sid], cb || (() => {}));
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteSessionStore(db),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — survives browser close
    // secure: true,
  }
}));

// Static serving for uploads
app.use('/uploads', express.static(dataPaths.uploadsDir));

// Run the schema statements below one after another. In node-sqlite3's default parallel mode a
// CREATE INDEX or ALTER TABLE could run before its CREATE TABLE, so FAS crashed on its first start
// with a new empty database ("no such table").
db.serialize();

db.run(`CREATE TABLE IF NOT EXISTS assets (
  assetId TEXT PRIMARY KEY,
  "group" TEXT,
  assetType TEXT,
  brandModel TEXT,
  serialNumber TEXT,
  hostName TEXT,
  assignedTo TEXT,
  department TEXT,
  ipAddress TEXT,
  macAddress TEXT,
  osFirmware TEXT,
  cpu TEXT,
  ram TEXT,
  storage TEXT,
  portDetails TEXT,
  powerConsumption TEXT,
  purchaseDate TEXT,
  warrantyExpiry TEXT,
  eol TEXT,
  maintenanceExpiry TEXT,
  cost TEXT,
  depreciation TEXT,
  residualValue TEXT,
  status TEXT,
  condition TEXT,
  usagePurpose TEXT,
  accessLevel TEXT,
  licenseKey TEXT,
  complianceStatus TEXT,
  documentation TEXT,
  remarks TEXT,
  lastAuditDate TEXT,
  disposedDate TEXT,
  replacementPlan TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS used_ids ( assetId TEXT PRIMARY KEY )`);

// ---- Consumables tables ----
db.run(`CREATE TABLE IF NOT EXISTS consumables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quantity INTEGER DEFAULT 0,
  company TEXT,
  customFields TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now'))
)`);

db.run(`CREATE TABLE IF NOT EXISTS consumable_custom_fields (
  fieldName TEXT PRIMARY KEY,
  fieldType TEXT NOT NULL,
  required INTEGER DEFAULT 0,
  sortOrder INTEGER DEFAULT 0
)`);

// Add sortOrder column if it doesn't exist (for existing databases)
db.run(`ALTER TABLE consumable_custom_fields ADD COLUMN sortOrder INTEGER DEFAULT 0`, (err) => {
  // Ignore error if column already exists
  if (err && !String(err.message).includes('duplicate column')) {
    console.error('Failed to add sortOrder column:', err.message);
  }
});

// Archived items leave the store list but keep their stock history; deleting an item used to
// delete its whole history with it (ON DELETE CASCADE below).
db.run(`ALTER TABLE consumables ADD COLUMN archived INTEGER DEFAULT 0`, (err) => {
  if (err && !String(err.message).includes('duplicate column')) {
    console.error('Failed to add archived column:', err.message);
  }
});

// An item's category also decides its ID prefix (Toner → TON-001); see consumablePrefix.
db.run(`ALTER TABLE consumables ADD COLUMN category TEXT`, (err) => {
  if (err && !String(err.message).includes('duplicate column')) {
    console.error('Failed to add category column:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS used_consumable_ids ( id TEXT PRIMARY KEY )`);

db.run(`CREATE TABLE IF NOT EXISTS consumable_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumableId TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT,
  performedBy TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (consumableId) REFERENCES consumables(id) ON DELETE CASCADE
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_consumable_transactions_consumableId ON consumable_transactions(consumableId)`);

db.parallelize();

// Safe migration to add invoiceUrl column if missing (legacy, last uploaded)
function ensureInvoiceColumn(cb) {
  db.all(`PRAGMA table_info(assets);`, [], (err, rows) => {
    if (err) return cb(err);
    const has = rows.some(r => String(r.name).toLowerCase() === 'invoiceurl');
    if (has) return cb();
    db.run(`ALTER TABLE assets ADD COLUMN invoiceUrl TEXT`, [], (err2) => {
      if (err2) return cb(err2);
      cb();
    });
  });
}
// Safe migration to add department column if missing
function ensureDepartmentColumn(cb) {
  db.all(`PRAGMA table_info(assets);`, [], (err, rows) => {
    if (err) return cb(err);
    const has = rows.some(r => String(r.name).toLowerCase() === 'department');
    if (has) return cb();
    db.run(`ALTER TABLE assets ADD COLUMN department TEXT`, [], (err2) => cb(err2 || null));
  });
}
// Safe migration to add hostName column if missing
function ensureHostNameColumn(cb) {
  db.all(`PRAGMA table_info(assets);`, [], (err, rows) => {
    if (err) return cb(err);
    const has = rows.some(r => String(r.name).toLowerCase() === 'hostname');
    if (has) return cb();
    db.run(`ALTER TABLE assets ADD COLUMN hostName TEXT`, [], (err2) => cb(err2 || null));
  });
}

// Safe migration to add labeled column if missing — tracks whether the
// physical asset tag/sticker has been printed and applied to the device.
// This is independent of assetId (the tag's printed value) and is never
// involved in any assetId/tag rename or normalization logic.
function ensureLabeledColumn(cb) {
  db.all(`PRAGMA table_info(assets);`, [], (err, rows) => {
    if (err) return cb(err);
    const has = rows.some(r => String(r.name).toLowerCase() === 'labeled');
    if (has) return cb();
    db.run(`ALTER TABLE assets ADD COLUMN labeled INTEGER DEFAULT 0`, [], (err2) => cb(err2 || null));
  });
}

// NEW: invoices table (1..N per asset)
function ensureInvoicesTable(cb) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS asset_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetId TEXT NOT NULL,
        url TEXT NOT NULL,
        uploadedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (assetId) REFERENCES assets(assetId) ON DELETE CASCADE
      )
    `, (e1) => {
      if (e1) return cb(e1);
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_asset_invoices_assetId ON asset_invoices(assetId)`,
        (e2) => cb(e2)
      );
    });
  });
}

function ensureImagesTable(cb) {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS asset_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetId TEXT NOT NULL,
        url TEXT NOT NULL,
        uploadedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (assetId) REFERENCES assets(assetId) ON DELETE CASCADE
      )
    `, (e1) => {
      if (e1) return cb(e1);
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_asset_images_assetId ON asset_images(assetId)`,
        (e2) => cb(e2)
      );
    });
  });
}

function ensureOcrColumn(cb) {
  db.all(`PRAGMA table_info(asset_images)`, (err, cols) => {
    if (err) return cb(err);
    if (cols.some(c => c.name === 'ocrText')) return cb(null);
    db.run(`ALTER TABLE asset_images ADD COLUMN ocrText TEXT`, cb);
  });
}

function ensureAuditLogTable(cb) {
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    NOT NULL DEFAULT (datetime('now')),
      user_email  TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      entity_type TEXT    NOT NULL,
      entity_id   TEXT,
      details_json TEXT,
      ip_address  TEXT
    )
  `, cb);
}

/* ---- Audit helper (fire-and-forget, never blocks the response) ---- */
function logAudit(req, action, entityType, entityId, details) {
  const user = req.session?.user?.email || (hasScanToken(req) ? 'scanner' : 'anonymous');
  const ip   = ((req.headers['x-forwarded-for'] || '') + ',' + (req.ip || ''))
                 .split(',')[0].trim() || 'unknown';
  db.run(
    `INSERT INTO audit_log (user_email, action, entity_type, entity_id, details_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user, action, entityType, String(entityId ?? ''), JSON.stringify(details ?? {}), ip],
    (err) => { if (err) console.error('Audit log error:', err.message); }
  );
}

// Columns that actually exist on the `assets` table (include legacy invoiceUrl)
const ASSET_COLUMNS = new Set([
  'assetId','group','assetType','brandModel','serialNumber','assignedTo','hostName','department',
  'ipAddress','macAddress','osFirmware','cpu','ram','storage','portDetails',
  'powerConsumption','purchaseDate','warrantyExpiry','eol','maintenanceExpiry',
  'cost','depreciation','residualValue','status','condition','usagePurpose',
  'accessLevel','licenseKey','complianceStatus','documentation','remarks',
  'lastAuditDate','disposedDate','replacementPlan','invoiceUrl'
]);

// Columns a bulk import (Scan Network, ManageEngine) fills, in INSERT order.
const BULK_COLUMNS = [
  'assetId','group','assetType','brandModel','serialNumber','hostName','assignedTo','department',
  'ipAddress','macAddress','osFirmware','cpu','ram','storage','portDetails','powerConsumption',
  'purchaseDate','warrantyExpiry','eol','maintenanceExpiry','cost','depreciation','residualValue',
  'status','condition','usagePurpose','accessLevel','licenseKey','complianceStatus','documentation',
  'remarks','lastAuditDate','disposedDate','replacementPlan'
];

function sanitizeAssetPayload(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (ASSET_COLUMNS.has(k)) out[k] = obj[k];
  }
  return out;
}

/* ---------- Helpers: normalization + required fields + txn rollback ------- */
function normalizeIp(v) {
  return (v || '').toString().trim();
}
function normalizeMac(v) {
  const raw = (v || '').toString().trim().toUpperCase();
  if (!raw) return '';
  const hex = raw.replace(/[^0-9A-F]/g, '');
  if (hex.length === 12) {
    return hex.match(/.{1,2}/g).join(':');
  }
  return raw;
}
function requireMinimalFields(body) {
  const required = ['group', 'assetType', 'assetId'];
  return required.filter(f => !body[f] || String(body[f]).trim() === '');
}
function rollback(e, res, status = 500) {
  db.run('ROLLBACK', () => res.status(status).json({ error: e.message }));
}

/* ------------- One-time dedupe then create UNIQUE partial indexes --------- */
function dedupeAndIndex(cb) {
  db.serialize(() => {
    // Null macAddress duplicates, keep earliest rowid
    db.run(`
      UPDATE assets
      SET macAddress = NULL
      WHERE rowid IN (
        SELECT a1.rowid
        FROM assets a1
        JOIN assets a2
          ON a1.macAddress = a2.macAddress
         AND a1.rowid > a2.rowid
        WHERE a1.macAddress IS NOT NULL AND a1.macAddress <> ''
      );
    `, function (err1) {
      if (err1) return cb(err1);

      // Null ipAddress duplicates, keep earliest rowid
      db.run(`
        UPDATE assets
        SET ipAddress = NULL
        WHERE rowid IN (
          SELECT a1.rowid
          FROM assets a1
          JOIN assets a2
            ON a1.ipAddress = a2.ipAddress
           AND a1.rowid > a2.rowid
          WHERE a1.ipAddress IS NOT NULL AND a1.ipAddress <> ''
        );
      `, function (err2) {
        if (err2) return cb(err2);

        // Create partial UNIQUE indexes (ignore NULL/empty)
        db.run(`
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_assets_mac ON assets(macAddress)
          WHERE macAddress IS NOT NULL AND macAddress <> '';
        `, function (err3) {
          if (err3) return cb(err3);

          db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_assets_ip ON assets(ipAddress)
            WHERE ipAddress IS NOT NULL AND ipAddress <> '';
          `, function (err4) {
            if (err4) return cb(err4);
            console.log('✅ Dedupe complete and unique indexes in place.');
            cb();
          });
        });
      });
    });
  });
}

/* --------------------------- LDAP Authentication ------------------------- */
function createLdapClient() {
  return ldap.createClient({ url: LDAP_URL });
}

async function ldapAuthenticate(usernameOrEmail, password) {
  const candidates = [];
  const raw = String(usernameOrEmail || '').trim();
  const isEmailOrUPN = raw.includes('@');

  if (isEmailOrUPN) {
    candidates.push(raw);
  } else {
    candidates.push(`${raw}@${LDAP_DEFAULT_UPN}`);
    candidates.push(`${raw}@${LDAP_ALT_UPN}`);
    candidates.push(`${LDAP_NETBIOS}\\${raw}`);
  }

  const attemptBind = (client, dn, pwd) => new Promise((resolve, reject) => {
    client.bind(dn, pwd, (err) => (err ? reject(err) : resolve()));
  });

  const searchAsync = (client, base, options) => new Promise((resolve, reject) => {
    const entries = [];
    client.search(base, options, (err, res) => {
      if (err) return reject(err);
      res.on('searchEntry', (entry) => entries.push(entry.object));
      res.on('error', reject);
      res.on('end', () => resolve(entries));
    });
  });

  let lastErr = null;
  for (const dn of candidates) {
    const client = createLdapClient();
    try {
      await attemptBind(client, dn, password);
      const results = await searchAsync(client, LDAP_BASE_DN, {
        scope: 'sub',
        filter: isEmailOrUPN
          ? `(|(userPrincipalName=${raw})(mail=${raw}))`
          : `(|(sAMAccountName=${raw})(userPrincipalName=${raw}@${LDAP_DEFAULT_UPN})(mail=${raw}@${LDAP_DEFAULT_UPN}))`,
        attributes: ['mail', 'userPrincipalName', 'displayName']
      });
      const user = results[0] || {};
      const email = (user.mail || user.userPrincipalName || raw || '').toLowerCase();
      try { client.unbind(); } catch {}
      return { email, displayName: user.displayName || email };
    } catch (e) {
      lastErr = e;
      try { client.unbind(); } catch {}
    }
  }

  const err = new Error('LDAP bind failed');
  err.cause = lastErr;
  throw err;
}

/* ---------------------------- Public routes ------------------------------ */
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await ldapAuthenticate(username, password);
    if (!user?.email || !isAllowedEmailOrUsername(user.email)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    req.session.user = { email: user.email, name: user.displayName };
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save failed' });
      res.json({ ok: true, user: req.session.user });
    });
  } catch {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'No session' });
  res.json({ user: req.session.user });
});

// Token-gated read-only fingerprints for scanner
app.get('/assets/fingerprints', (req, res) => {
  if (!hasScanToken(req)) return res.status(401).json({ error: 'Auth required' });

  db.all('SELECT ipAddress, macAddress FROM assets', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const ips = new Set();
    const macs = new Set();
    for (const r of rows) {
      const ip = normalizeIp(r.ipAddress);
      const mac = normalizeMac(r.macAddress);
      if (ip) ips.add(ip);
      if (mac) macs.add(mac);
    }
    res.json({ ips: Array.from(ips), macs: Array.from(macs) });
  });
});

/* --- Serve React static build files before the auth guard so the app shell
     loads without a session (JS/CSS/index.html are always public).          --- */
const BUILD_DIR = path.resolve(__dirname, '..', 'build');
if (fs.existsSync(BUILD_DIR)) {
  app.use(express.static(BUILD_DIR));
}

/* --------------------------- Auth Guard (global) ------------------------- */
const API_PREFIXES = ['/health', '/auth', '/assets', '/consumables', '/documents', '/scan', '/uploads', '/manageengine'];

app.use((req, res, next) => {
  if (
    req.path.startsWith('/health') ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/assets/next-id') || // public for scanner/UI
    req.path.startsWith('/assets/fingerprints') // self-token-checked above
  ) return next();

  // Allow scanner token to call import/list endpoints without a session
  if (hasScanToken(req) && (
      (req.method === 'POST' && req.path === '/assets') ||
      (req.method === 'POST' && req.path === '/assets/bulk') ||
 (req.method === 'GET'  && req.path === '/assets') || // optional fallback
 (req.method === 'POST' && req.path === '/scan') ||
 (req.method === 'GET'  && req.path === '/scan/stream')  )) return next();

  if (!req.session?.user) {
    const isApiCall = API_PREFIXES.some(p => req.path.startsWith(p));
    if (isApiCall) return res.status(401).json({ error: 'Auth required' });
    // Non-API path (SPA route): serve index.html so React handles auth
    const idx = path.join(BUILD_DIR, 'index.html');
    return fs.existsSync(idx)
      ? res.sendFile(idx)
      : res.status(401).json({ error: 'Auth required' });
  }
  next();
});

/* ------------------------------ Assets API ------------------------------- */
// Supports optional server-side filtering + pagination.
// page=0 (or omitted) → returns all rows as a flat array (backward compat / export).
// page>0             → returns { items, total, page, pageSize }.
app.get('/assets', (req, res) => {
  const page     = parseInt(req.query.page) || 0;
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize) || 100));
  const search   = (req.query.search || '').trim();
  const groups   = req.query.group       ? req.query.group.split(',').map(s => s.trim()).filter(Boolean) : [];
  const types    = req.query.assetType   ? req.query.assetType.split(',').map(s => s.trim()).filter(Boolean) : [];
  const depts    = req.query.department  ? req.query.department.split(',').map(s => s.trim()).filter(Boolean) : [];

  const whereParts = [], whereParams = [];

  if (search) {
    const cols = ['a.assetId','a.brandModel','a.serialNumber','a.assignedTo',
                  'a.department','a.assetType','a."group"','a.hostName',
                  'a.ipAddress','a.macAddress','a.remarks'];
    // Also search OCR text extracted from uploaded images
    const ocrSubq = `EXISTS (SELECT 1 FROM asset_images _img WHERE _img.assetId = a.assetId AND _img.ocrText LIKE ?)`;
    whereParts.push(`(${cols.map(c => `${c} LIKE ?`).join(' OR ')} OR ${ocrSubq})`);
    cols.forEach(() => whereParams.push(`%${search}%`));
    whereParams.push(`%${search}%`); // param for OCR subquery
  }
  if (groups.length) { whereParts.push(`a."group" IN (${groups.map(() => '?').join(',')})`);     whereParams.push(...groups); }
  if (types.length)  { whereParts.push(`a.assetType IN (${types.map(() => '?').join(',')})`);    whereParams.push(...types);  }
  if (depts.length)  { whereParts.push(`a.department IN (${depts.map(() => '?').join(',')})`);   whereParams.push(...depts);  }
  if (req.query.labeled === '0' || req.query.labeled === '1') {
    whereParts.push(`COALESCE(a.labeled, 0) = ?`);
    whereParams.push(req.query.labeled === '1' ? 1 : 0);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  db.get(`SELECT COUNT(*) AS total FROM assets a ${where}`, whereParams, (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });

    let sql = `
      SELECT a.*,
             GROUP_CONCAT(ai.url, '||') AS __invoices
      FROM assets a
      LEFT JOIN asset_invoices ai ON ai.assetId = a.assetId
      ${where}
      GROUP BY a.assetId
      ORDER BY a.assetId
    `;
    const sqlParams = [...whereParams];
    if (page > 0) { sql += ' LIMIT ? OFFSET ?'; sqlParams.push(pageSize, (page - 1) * pageSize); }

    db.all(sql, sqlParams, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const items = rows.map(r => {
        const arr = r.__invoices
          ? r.__invoices.split('||').filter(Boolean)
          : (r.invoiceUrl ? [r.invoiceUrl] : []);
        delete r.__invoices;
        return { ...r, invoiceUrls: arr };
      });
      if (page > 0) {
        res.json({ items, total: countRow.total, page, pageSize });
      } else {
        res.json(items);
      }
    });
  });
});

// Distinct Group / Asset Type / Department values across the WHOLE table —
// powers the filter dropdowns so options aren't limited to whatever is on
// the current page of results.
app.get('/assets/filter-options', (req, res) => {
  const distinctValues = (column) => new Promise((resolve, reject) => {
    db.all(
      `SELECT DISTINCT ${column} AS val FROM assets WHERE ${column} IS NOT NULL AND TRIM(${column}) <> '' ORDER BY val COLLATE NOCASE`,
      [],
      (err, rows) => err ? reject(err) : resolve(rows.map(r => r.val))
    );
  });

  Promise.all([
    distinctValues('"group"'),
    distinctValues('assetType'),
    distinctValues('department'),
  ])
    .then(([groupsList, assetTypes, departments]) => {
      res.json({ groups: groupsList, assetTypes, departments });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

// Add new asset — normalization + INSERT OR IGNORE (skip on dup)
app.post('/assets', (req, res) => {
  const body = { ...req.body };

  // Compose brandModel from brand/model if provided (legacy UI fields)
  if ((body.brand && body.brand.trim()) || (body.model && body.model.trim())) {
    const bm = `${(body.brand || '').trim()} ${(body.model || '').trim()}`.trim();
    if (bm && !body.brandModel) body.brandModel = bm;
  }

  // Keep only columns that exist on `assets`; drops invoiceUrls etc.
  const asset = sanitizeAssetPayload(body);

  const missing = requireMinimalFields(asset);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  asset.ipAddress = normalizeIp(asset.ipAddress);
  asset.macAddress = normalizeMac(asset.macAddress);

  const fields = Object.keys(asset).map(f => (f === 'group' ? `"group"` : f));
  const placeholders = fields.map(() => '?').join(',');
  const sql = `INSERT OR IGNORE INTO assets (${fields.join(',')}) VALUES (${placeholders})`;

  db.run(sql, Object.values(asset), function (err) {
    if (err) {
      const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
      return res.status(status).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(200).json({ skipped: true, id: asset.assetId });
    }
    db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [asset.assetId]);
    logAudit(req, 'asset.created', 'asset', asset.assetId, { assetType: asset.assetType, group: asset.group });
    res.status(201).json({ id: asset.assetId, inserted: true });
  });
});

// Bulk add — normalization + counts inserted vs skipped
// Check which serial numbers already exist in the DB
// Body: { serials: ['SN1', 'SN2', ...] }
// Returns: { existing: { 'SN1': { assetId, hostName, assignedTo, assetType }, ... } }
app.post('/assets/check-serials', (req, res) => {
  const { serials } = req.body || {};
  if (!Array.isArray(serials) || serials.length === 0) return res.json({ existing: {} });
  const clean = [...new Set(serials.map(s => String(s).trim()).filter(Boolean))];
  if (clean.length === 0) return res.json({ existing: {} });
  const ph = clean.map(() => '?').join(',');
  db.all(
    `SELECT assetId, serialNumber, hostName, assignedTo, assetType, "group" FROM assets WHERE serialNumber IN (${ph})`,
    clean,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const existing = {};
      for (const row of rows) {
        if (row.serialNumber) existing[row.serialNumber] = row;
      }
      res.json({ existing });
    }
  );
});

app.post('/assets/bulk', (req, res) => {
  const list = req.body?.assets;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: 'No assets provided' });
  const required = ['assetId', 'group', 'assetType'];
  const badIdx = list.findIndex(a => required.some(f => !a[f] || String(a[f]).trim() === ''));
  if (badIdx >= 0) return res.status(400).json({ error: `Asset at index ${badIdx} missing required fields` });

  const listNorm = list.map(a => {
    const out = {
      ...a,
      ipAddress: normalizeIp(a.ipAddress),
      macAddress: normalizeMac(a.macAddress),
    };
    if ((out.brand && String(out.brand).trim()) || (out.model && String(out.model).trim())) {
      const bm = `${String(out.brand || '').trim()} ${String(out.model || '').trim()}`.trim();
      if (bm && !out.brandModel) out.brandModel = bm;
      delete out.brand;
      delete out.model;
    }
    return out;
  });

  // The placeholders are built from the column list, so the two can never disagree again. A
  // hand-typed list had 34 columns and 33 "?", and every Scan Network or ManageEngine import
  // failed with "33 values for 34 columns" and took the whole server down with it.
  const placeholders = BULK_COLUMNS.map(() => '?').join(',');
  const sql = `INSERT OR IGNORE INTO assets (${BULK_COLUMNS.map(c => (c === 'group' ? '"group"' : c)).join(',')}) VALUES (${placeholders})`;

  // One row at a time, so a real failure can stop the import and be reported.
  let insertedCount = 0;
  let i = 0;
  const insertNext = () => {
    if (i >= listNorm.length) {
      const skipped = listNorm.length - insertedCount;
      logAudit(req, 'asset.bulk_imported', 'asset', '', { inserted: insertedCount, skipped });
      return res.json({ inserted: insertedCount, skipped });
    }
    const a = listNorm[i++];
    db.run(sql, BULK_COLUMNS.map(c => a[c] ?? null), function (err) {
      // OR IGNORE already turns a duplicate assetId, MAC or IP into a skipped row (no error).
      if (err) return res.status(500).json({ error: err.message, inserted: insertedCount });
      if (this.changes > 0) {
        insertedCount += 1;
        db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [a.assetId]);
      }
      insertNext();
    });
  };
  insertNext();
});

// Update existing — normalization; 409 on MAC/IP collisions
app.put('/assets/:id', (req, res) => {
  const body = { ...req.body };

  // Compose brandModel from brand/model if provided
  if ((body.brand && body.brand.trim()) || (body.model && body.model.trim())) {
    const bm = `${(body.brand || '').trim()} ${(body.model || '').trim()}`.trim();
    if (bm && !body.brandModel) body.brandModel = bm;
  }

  // Keep only columns that exist on `assets`; drops invoiceUrls etc.
  const asset = sanitizeAssetPayload(body);

  const oldId = req.params.id;
  const newId = asset.assetId;

  if (!asset || Object.keys(asset).length === 0) return res.status(400).json({ error: 'No data provided for update' });
  const missing = requireMinimalFields(asset);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  asset.ipAddress = normalizeIp(asset.ipAddress);
  asset.macAddress = normalizeMac(asset.macAddress);

  const fields = Object.keys(asset).map(f => (f === 'group' ? `"group"` : f));
  const placeholders = fields.map(() => '?').join(',');

  if (oldId !== newId) {
    // Carry the existing "labeled" status over to the new row — it's
    // unrelated to the assetId/tag value being changed and shouldn't be
    // silently reset by the delete+reinsert below.
    db.get(`SELECT labeled FROM assets WHERE assetId = ?`, [oldId], (errLabel, labelRow) => {
      if (errLabel) return rollback(errLabel, res);
      const labeledVal = labelRow ? (labelRow.labeled ?? 0) : 0;
      const fieldsWithLabeled = [...fields, 'labeled'];
      const placeholdersWithLabeled = fieldsWithLabeled.map(() => '?').join(',');

      db.serialize(() => {
        // Disable FK enforcement so we can migrate child records before deleting
        // the parent row (otherwise ON DELETE CASCADE would wipe images/invoices).
        db.run('PRAGMA foreign_keys = OFF');
        db.run('BEGIN EXCLUSIVE');
        // Migrate all child records to the new assetId BEFORE deleting the old row
        db.run(`UPDATE asset_images   SET assetId = ? WHERE assetId = ?`, [newId, oldId]);
        db.run(`UPDATE asset_invoices SET assetId = ? WHERE assetId = ?`, [newId, oldId]);
        db.run(`UPDATE document_assets SET assetId = ? WHERE assetId = ?`, [newId, oldId]);
        db.run(`DELETE FROM assets WHERE assetId = ?`, [oldId], function (err) {
          if (err) {
            db.run('ROLLBACK');
            db.run('PRAGMA foreign_keys = ON');
            return rollback(err, res);
          }
          const sqlInsert = `INSERT INTO assets (${fieldsWithLabeled.join(',')}) VALUES (${placeholdersWithLabeled})`;
          db.run(sqlInsert, [...Object.values(asset), labeledVal], function (err2) {
            if (err2) {
              db.run('ROLLBACK');
              db.run('PRAGMA foreign_keys = ON');
              const status = String(err2.code).includes('CONSTRAINT') ? 409 : 500;
              return rollback(err2, res, status);
            }
            db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [newId], function (err3) {
              if (err3) {
                db.run('ROLLBACK');
                db.run('PRAGMA foreign_keys = ON');
                return rollback(err3, res);
              }
              db.run('COMMIT', () => {
                db.run('PRAGMA foreign_keys = ON');
                logAudit(req, 'asset.updated', 'asset', newId, { previousId: oldId });
                res.json({ updated: 1 });
              });
            });
          });
        });
      });
    });
  } else {
    const updates = Object.keys(asset).map(k => `${k === 'group' ? `"group"` : k} = ?`).join(', ');
    const sql = `UPDATE assets SET ${updates} WHERE assetId = ?`;
    const values = [...Object.values(asset), oldId];
    db.run(sql, values, function (err) {
      if (err) {
        const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
        return res.status(status).json({ error: err.message });
      }
      logAudit(req, 'asset.updated', 'asset', oldId, {});
      res.json({ updated: this.changes });
    });
  }
});

// Mark/unmark an asset as physically labeled (tagged). This ONLY touches the
// `labeled` flag — it never reads or writes assetId or any other field, so it
// can never change an asset's tag.
app.patch('/assets/:id/labeled', (req, res) => {
  const id = req.params.id;
  const labeled = req.body?.labeled ? 1 : 0;
  db.run(`UPDATE assets SET labeled = ? WHERE assetId = ?`, [labeled, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Asset not found' });
    logAudit(req, labeled ? 'asset.labeled' : 'asset.unlabeled', 'asset', id, {});
    res.json({ assetId: id, labeled: !!labeled });
  });
});

// Overall labeling progress (independent of any current search/filter).
app.get('/assets/label-stats', (req, res) => {
  db.get(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(labeled, 0) = 1 THEN 1 ELSE 0 END) AS labeled FROM assets`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = row?.total || 0;
      const labeled = row?.labeled || 0;
      res.json({ total, labeled, unlabeled: total - labeled });
    }
  );
});

app.delete('/assets/:id', (req, res) => {
  db.run(`DELETE FROM assets WHERE assetId = ?`, req.params.id, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes > 0) {
      // The archive documents stay; only their link to this asset goes
      db.run(`DELETE FROM document_assets WHERE assetId = ?`, [req.params.id]);
      logAudit(req, 'asset.deleted', 'asset', req.params.id, {});
    }
    res.json({ deleted: this.changes });
  });
});

app.delete('/assets/force-delete', (req, res) => {
  const { assetId, macAddress, ipAddress } = req.query;
  if (!assetId && !macAddress && !ipAddress) return res.status(400).json({ error: 'Must provide at least assetId, macAddress, or ipAddress' });

  const conditions = [], params = [];
  if (assetId)   { conditions.push('assetId = ?');   params.push(assetId); }
  if (macAddress){ conditions.push('macAddress = ?');params.push(normalizeMac(macAddress)); }
  if (ipAddress) { conditions.push('ipAddress = ?'); params.push(normalizeIp(ipAddress)); }
  const sql = `DELETE FROM assets WHERE ${conditions.join(' OR ')}`;
  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// Public-read (scanner + UI) — next id (atomic: reserves the ID inside a transaction)
app.get('/assets/next-id/:type', (req, res) => {
  const rawType = req.params.type;
  if (!rawType || rawType.length < 2) return res.status(400).json({ error: 'Invalid asset type' });

  const safePrefix = rawType.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
  if (!safePrefix) return res.status(400).json({ error: 'Invalid asset type prefix' });

  db.serialize(() => {
    db.run('BEGIN EXCLUSIVE', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT assetId FROM used_ids WHERE assetId LIKE ?`, [`${safePrefix}-%`], (err, rows) => {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
        const numbers = rows
          .map(row => {
            const m = row.assetId.match(new RegExp(`^${safePrefix}-(\\d+)$`));
            return m ? parseInt(m[1], 10) : null;
          })
          .filter(n => n !== null);
        const next = numbers.length ? Math.max(...numbers) + 1 : 1;
        const id = `${safePrefix}-${String(next).padStart(3, '0')}`;
        db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [id], (err) => {
          if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
          db.run('COMMIT', () => res.json({ id }));
        });
      });
    });
  });
});

// Bulk ID generation — generates N IDs in ONE exclusive transaction (no parallel-request collisions).
// Body: { types: ['Desktop / Laptop', 'Monitor', 'Laptop', ...] }
// Returns: { ids: ['DES-001', 'MON-001', 'LAP-001', ...] }  — one id per type, same order.
app.post('/assets/bulk-next-ids', (req, res) => {
  const { types } = req.body || {};
  if (!Array.isArray(types) || types.length === 0)
    return res.status(400).json({ error: 'types array is required' });

  db.serialize(() => {
    db.run('BEGIN EXCLUSIVE', (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Read ALL currently reserved IDs once
      db.all('SELECT assetId FROM used_ids', [], (err, rows) => {
        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }

        // Build prefix → current-max counter from existing IDs
        const counters = {};
        for (const { assetId } of rows) {
          const m = assetId.match(/^([A-Z]{1,4})-(\d+)$/);
          if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, parseInt(m[2], 10));
        }

        // Derive one new ID per requested type (incrementing the counter each time)
        const newIds = types.map(type => {
          const prefix = String(type || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
          if (!prefix) return null;
          counters[prefix] = (counters[prefix] || 0) + 1;
          return `${prefix}-${String(counters[prefix]).padStart(3, '0')}`;
        });

        const validIds = newIds.filter(Boolean);

        // Insert all new IDs sequentially inside the same exclusive transaction
        let i = 0;
        const insertNext = () => {
          if (i >= validIds.length) {
            db.run('COMMIT', (err) => {
              if (err) return res.status(500).json({ error: err.message });
              res.json({ ids: newIds });
            });
            return;
          }
          db.run('INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)', [validIds[i++]], (err) => {
            if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
            insertNext();
          });
        };
        insertNext();
      });
    });
  });
});

/* -------------------------- Invoices upload API -------------------------- */
const invoicesDir = dataPaths.invoicesDir;
fs.mkdirSync(invoicesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, invoicesDir),
  filename: (req, file, cb) => {
    const assetId = req.params.assetId || 'unknown';
    const ext = path.extname(file.originalname || '.pdf') || '.pdf';
    cb(null, `${assetId}-${Date.now()}${ext}`);
  }
});

const uploadPdfOnly = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || (file.originalname || '').toLowerCase().endsWith('.pdf');
    if (!ok) return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  }
});

// Upload a single invoice: append to asset_invoices and update legacy invoiceUrl
app.post('/assets/:assetId/invoice', uploadPdfOnly.single('file'), (req, res) => {
  const { assetId } = req.params;
  if (!assetId) return res.status(400).json({ error: 'assetId is required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const invoiceUrl = `/uploads/invoices/${req.file.filename}`;

  db.serialize(() => {
    db.get(`SELECT 1 FROM assets WHERE assetId = ?`, [assetId], (e0, row) => {
      if (e0) return res.status(500).json({ error: e0.message });
      if (!row) return res.status(404).json({ error: 'Asset not found' });

      db.run(
        `INSERT INTO asset_invoices (assetId, url) VALUES (?, ?)`,
        [assetId, invoiceUrl],
        function (e1) {
          if (e1) return res.status(500).json({ error: e1.message });

          // keep last uploaded in legacy column for older clients
          db.run(
            `UPDATE assets SET invoiceUrl = ? WHERE assetId = ?`,
            [invoiceUrl, assetId],
            function (e2) {
              if (e2) return res.status(500).json({ error: e2.message });
              res.json({ url: invoiceUrl });
            }
          );
        }
      );
    });
  });
});

// List invoices per asset (with ids for deletion)
app.get('/assets/:assetId/invoices', (req, res) => {
  const { assetId } = req.params;
  db.all(
    `SELECT id, url, uploadedAt FROM asset_invoices WHERE assetId = ? ORDER BY uploadedAt ASC, id ASC`,
    [assetId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ invoices: rows });
    }
  );
});

// DELETE an invoice (requires confirm=true); updates legacy invoiceUrl; removes file
app.delete('/assets/:assetId/invoices/:invoiceId', (req, res) => {
  const { assetId, invoiceId } = req.params;
  const { confirm } = req.query;

  // Simple server-side "confirmation" gate; client should prompt user and send confirm=true
  if (confirm !== 'true') {
    return res.status(400).json({ error: 'Confirmation required. Re-send with ?confirm=true after user confirms.' });
  }

  db.get(
    `SELECT url FROM asset_invoices WHERE id = ? AND assetId = ?`,
    [invoiceId, assetId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Invoice not found for this asset' });

      const fileUrl = row.url || '';
      const filename = path.basename(fileUrl); // prevents path traversal
      const absPath = path.join(invoicesDir, filename);

      // Delete DB row first
      db.run(`DELETE FROM asset_invoices WHERE id = ? AND assetId = ?`, [invoiceId, assetId], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Invoice not found (nothing deleted)' });

        // Remove file (best-effort)
        fs.unlink(absPath, () => { /* ignore errors (file may have been moved/deleted) */ });

        // Update legacy latest invoiceUrl to most recent remaining (or NULL)
        db.get(
          `SELECT url FROM asset_invoices WHERE assetId = ? ORDER BY uploadedAt DESC, id DESC LIMIT 1`,
          [assetId],
          (err3, latest) => {
            if (err3) return res.status(500).json({ error: err3.message });
            const latestUrl = latest?.url || null;
            db.run(
              `UPDATE assets SET invoiceUrl = ? WHERE assetId = ?`,
              [latestUrl, assetId],
              function (err4) {
                if (err4) return res.status(500).json({ error: err4.message });

                // Also return remaining count for convenience
                db.get(
                  `SELECT COUNT(*) AS cnt FROM asset_invoices WHERE assetId = ?`,
                  [assetId],
                  (err5, cntRow) => {
                    if (err5) return res.status(500).json({ error: err5.message });
                    res.json({
                      deleted: true,
                      deletedInvoiceUrl: fileUrl,
                      latestInvoiceUrl: latestUrl,
                      remaining: cntRow?.cnt ?? 0
                    });
                  }
                );
              }
            );
          }
        );
      });
    }
  );
});

/* ------------------------- ManageEngine Proxy API ------------------------ */
app.post('/manageengine/fetch', async (req, res) => {
  const { url, apiKey } = req.body || {};
  if (!url || !apiKey) return res.status(400).json({ error: 'url and apiKey are required' });

  const base = url.replace(/\/+$/, '');
  const headers = { Authorization: apiKey, Accept: 'application/json' };

  try {
    // Step 1: fetch all computers
    const compRes = await fetch(`${base}/api/1.3/inventory/computers`, { headers });
    if (!compRes.ok) {
      const txt = await compRes.text().catch(() => '');
      return res.status(502).json({ error: `ManageEngine returned ${compRes.status}: ${txt.slice(0, 200)}` });
    }
    const compData = await compRes.json();
    const computers = compData?.message_response?.computers || [];

    if (computers.length === 0) return res.json({ devices: [] });

    // Step 2: fetch hardware details for each computer (cap at 200 to avoid timeout)
    const capped = computers.slice(0, 200);
    const devices = await Promise.all(capped.map(async (comp) => {
      let hw = {};
      try {
        const hwRes = await fetch(
          `${base}/api/1.3/inventory/hardware?resourceId=${comp.resource_id}`,
          { headers, signal: AbortSignal.timeout(8000) }
        );
        if (hwRes.ok) {
          const hwData = await hwRes.json();
          hw = hwData?.message_response?.hardware || {};
        }
      } catch { /* hardware detail optional — skip on timeout */ }

      const osName = comp.os_name || hw.os_name || '';
      return {
        hostName:     comp.resource_name || '',
        serialNumber: hw.serial_number  || '',
        brandModel:   [hw.manufacturer, hw.model].filter(Boolean).join(' '),
        assignedTo:   hw.last_loggedon_user || comp.last_contact_user || '',
        department:   comp.department || '',
        ipAddress:    comp.ip_address  || '',
        macAddress:   hw.mac_address   || '',
        osFirmware:   osName,
        cpu:          hw.processor_type || hw.cpu_type || '',
        ram:          hw.total_ram  ? `${hw.total_ram} MB`  : '',
        storage:      hw.total_harddisk ? `${hw.total_harddisk} GB` : '',
        status:       'Active',
      };
    }));

    res.json({ devices, total: computers.length, fetched: capped.length });
  } catch (e) {
    res.status(502).json({ error: `Could not reach ManageEngine: ${e.message}` });
  }
});

/* ----------------------------- Consumables API --------------------------- */
// A whole number from a JSON body value (5 or "5"), or null. Stock is counted in whole units,
// and a value sent as text must not be joined onto the stock as text ("10" + "5").
function toWholeNumber(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) ? n : null;
}

// Get all consumables with custom fields merged. Archived items only with ?includeArchived=1.
app.get('/consumables', (req, res) => {
  const where = req.query.includeArchived === '1' ? '' : 'WHERE COALESCE(archived, 0) = 0';
  db.all(`SELECT * FROM consumables ${where} ORDER BY id`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(r => ({
      ...r,
      archived: Boolean(r.archived),
      customFields: r.customFields ? JSON.parse(r.customFields) : {}
    }));
    res.json(parsed);
  });
});

// An item's ID prefix: the first 3 letters or digits of its category, as asset IDs take theirs
// from the asset type (Toner → TON-001, Cables → CAB-001). No category, or one with no Latin
// letters (an Arabic name), keeps the original CONS-001 numbering.
function consumablePrefix(category) {
  const p = String(category || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
  return p || 'CONS';
}

// The next number for an ID prefix. used_consumable_ids keeps every ID ever given out
// (archived items included), so a number is never handed out twice.
// Parameters: prefix length + 2 (where the number starts), then the GLOB pattern "PREFIX-[0-9]*".
const NEXT_CONSUMABLE_NUMBER = `
  SELECT COALESCE(MAX(CAST(substr(x.id, ?) AS INTEGER)), 0) + 1
  FROM (SELECT id FROM used_consumable_ids UNION SELECT id FROM consumables) x
  WHERE x.id GLOB ?`;

// Preview of the next ID for a category (?category=Toner). Not reserved: the add itself takes
// the next free number, so it can differ if someone else adds an item in the same category first.
app.get('/consumables/next-id', (req, res) => {
  const prefix = consumablePrefix(req.query.category);
  db.get(`SELECT (${NEXT_CONSUMABLE_NUMBER}) AS n`, [prefix.length + 2, `${prefix}-[0-9]*`], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: `${prefix}-${String(row.n).padStart(3, '0')}` });
  });
});

// Add new consumable. Without an id in the body, the next ID for its category is chosen in the
// same INSERT, so two people adding at the same moment cannot get the same ID.
app.post('/consumables', (req, res) => {
  const { id, name, quantity, company, category, customFields } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const opening = quantity === undefined || quantity === null || quantity === '' ? 0 : toWholeNumber(quantity);
  if (opening === null || opening < 0) {
    return res.status(400).json({ error: 'Opening stock must be a whole number, 0 or more' });
  }

  const cat = typeof category === 'string' && category.trim() ? category.trim() : null;
  const customFieldsJson = customFields ? JSON.stringify(customFields) : null;
  const values = [name, opening, company || null, cat, customFieldsJson];
  let sql, params;
  if (id) {
    sql = `INSERT INTO consumables (id, name, quantity, company, category, customFields) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`;
    params = [id, ...values];
  } else {
    const prefix = consumablePrefix(cat);
    sql = `INSERT INTO consumables (id, name, quantity, company, category, customFields)
           SELECT ? || '-' || printf('%03d', (${NEXT_CONSUMABLE_NUMBER})), ?, ?, ?, ?, ? RETURNING id`;
    params = [prefix, prefix.length + 2, `${prefix}-[0-9]*`, ...values];
  }

  db.get(sql, params, (err, row) => {
    if (err) {
      const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
      return res.status(status).json({ error: err.message });
    }
    const newId = row.id;
    db.run(`INSERT OR IGNORE INTO used_consumable_ids (id) VALUES (?)`, [newId]);
    // The opening stock is the first row of the item's history, so the history adds up to the stock.
    if (opening > 0) {
      db.run(
        `INSERT INTO consumable_transactions (consumableId, type, quantity, reason, performedBy) VALUES (?, 'opening', ?, 'Opening stock', ?)`,
        [newId, opening, req.session?.user?.email || 'system']
      );
    }
    logAudit(req, 'consumable.created', 'consumable', newId, { name, category: cat, openingStock: opening });
    res.status(201).json({ id: newId, inserted: true });
  });
});

// Update consumable. The quantity is left out on purpose: stock changes only through
// /consumables/:id/transaction, so each change is in the history. Saving the edit form used to
// write back the quantity it had loaded, silently undoing any stock change made since.
app.put('/consumables/:id', (req, res) => {
  const { id } = req.params;
  const { name, company, category, customFields } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Changing the category keeps the item's ID: the ID is already on its label.
  const cat = typeof category === 'string' && category.trim() ? category.trim() : null;
  const customFieldsJson = customFields ? JSON.stringify(customFields) : null;
  const sql = `UPDATE consumables SET name = ?, company = ?, category = ?, customFields = ?, updatedAt = datetime('now') WHERE id = ?`;

  db.run(sql, [name, company || null, cat, customFieldsJson, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Consumable not found' });
    logAudit(req, 'consumable.updated', 'consumable', id, { name });
    res.json({ updated: this.changes });
  });
});

// "Delete" archives the item: it leaves the list and takes no more stock changes, but the item
// and its history stay in the database, and it can be restored.
app.delete('/consumables/:id', (req, res) => {
  db.run(`UPDATE consumables SET archived = 1, updatedAt = datetime('now') WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Consumable not found' });
    logAudit(req, 'consumable.archived', 'consumable', req.params.id, {});
    res.json({ archived: this.changes });
  });
});

app.post('/consumables/:id/restore', (req, res) => {
  db.run(`UPDATE consumables SET archived = 0, updatedAt = datetime('now') WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Consumable not found' });
    logAudit(req, 'consumable.restored', 'consumable', req.params.id, {});
    res.json({ restored: this.changes });
  });
});

// Get custom fields
app.get('/consumables/fields', (req, res) => {
  db.all('SELECT * FROM consumable_custom_fields ORDER BY sortOrder, fieldName', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, required: Boolean(r.required) })));
  });
});

// Add custom field
app.post('/consumables/fields', (req, res) => {
  const { fieldName, fieldType, required } = req.body;

  if (!fieldName || !fieldType) {
    return res.status(400).json({ error: 'fieldName and fieldType are required' });
  }

  // Get the max sortOrder and add 1 for the new field
  db.get('SELECT MAX(sortOrder) as maxOrder FROM consumable_custom_fields', [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const nextOrder = (row?.maxOrder || 0) + 1;
    const sql = `INSERT INTO consumable_custom_fields (fieldName, fieldType, required, sortOrder) VALUES (?, ?, ?, ?)`;

    db.run(sql, [fieldName, fieldType, required ? 1 : 0, nextOrder], function (err) {
      if (err) {
        const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
        return res.status(status).json({ error: err.message });
      }
      logAudit(req, 'consumable_field.added', 'consumable_field', fieldName, { fieldType, required: !!required });
      res.status(201).json({ fieldName, added: true });
    });
  });
});

// Delete custom field
app.delete('/consumables/fields/:fieldName', (req, res) => {
  db.run(`DELETE FROM consumable_custom_fields WHERE fieldName = ?`, req.params.fieldName, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes > 0) logAudit(req, 'consumable_field.deleted', 'consumable_field', req.params.fieldName, {});
    res.json({ deleted: this.changes });
  });
});

// Reorder custom fields. One UPDATE sets every position, so there is no BEGIN to collide with
// another request's open transaction on the shared connection, and an empty list cannot leave
// a transaction open.
app.post('/consumables/fields/reorder', (req, res) => {
  const { fieldNames } = req.body || {};

  if (!Array.isArray(fieldNames)) {
    return res.status(400).json({ error: 'fieldNames must be an array' });
  }
  if (fieldNames.length === 0) return res.json({ success: true, updated: 0 });

  const cases = fieldNames.map(() => 'WHEN ? THEN ?').join(' ');
  const inList = fieldNames.map(() => '?').join(',');
  const params = [...fieldNames.flatMap((fieldName, index) => [fieldName, index]), ...fieldNames];
  db.run(
    `UPDATE consumable_custom_fields SET sortOrder = CASE fieldName ${cases} END WHERE fieldName IN (${inList})`,
    params,
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, updated: this.changes });
    }
  );
});

// Change the stock: "add" (stock in), "subtract" (use from stock) or "adjust" (a stock count).
// This is the only way the stock changes, so every change is in consumable_transactions.
// Each change is one UPDATE that checks and moves the stock in the same statement, so two people
// pressing at the same moment can neither both take the last unit nor crash the server. (Before,
// each request read the stock, then opened its own BEGIN on the shared connection; the second
// BEGIN failed with "cannot start a transaction within a transaction" and ended the process.)
app.post('/consumables/:id/transaction', (req, res) => {
  const { id } = req.params;
  const { type, reason } = req.body || {};

  if (!['add', 'subtract', 'adjust'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "add", "subtract" or "adjust"' });
  }

  let sql, params, change;
  if (type === 'adjust') {
    // Set the stock to what was counted, but only while it is still what the person saw when
    // they started counting, so a change made meanwhile is not overwritten.
    const counted = toWholeNumber(req.body.countedQuantity);
    const expected = toWholeNumber(req.body.expectedQuantity);
    if (counted === null || counted < 0 || expected === null) {
      return res.status(400).json({ error: 'Counted quantity must be a whole number, 0 or more' });
    }
    if (counted === expected) {
      return res.status(400).json({ error: 'The count matches the current stock, so there is nothing to change' });
    }
    change = counted - expected;
    sql = `UPDATE consumables SET quantity = ?, updatedAt = datetime('now')
           WHERE id = ? AND COALESCE(archived, 0) = 0 AND COALESCE(quantity, 0) = ? RETURNING quantity`;
    params = [counted, id, expected];
  } else {
    const qty = toWholeNumber(req.body.quantity);
    if (qty === null || qty <= 0) {
      return res.status(400).json({ error: 'Quantity must be a whole number above 0' });
    }
    change = type === 'add' ? qty : -qty;
    sql = `UPDATE consumables SET quantity = COALESCE(quantity, 0) + ?, updatedAt = datetime('now')
           WHERE id = ? AND COALESCE(archived, 0) = 0 AND COALESCE(quantity, 0) + ? >= 0 RETURNING quantity`;
    params = [change, id, change];
  }

  const performedBy = req.session?.user?.email || 'system';

  db.get(sql, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!row) {
      // Nothing changed: find out why.
      return db.get('SELECT quantity, archived FROM consumables WHERE id = ?', [id], (err2, item) => {
        if (err2) return res.status(500).json({ error: err2.message });
        if (!item) return res.status(404).json({ error: 'Consumable not found' });
        if (item.archived) return res.status(400).json({ error: 'This item is archived. Restore it before changing its stock.' });
        if (type === 'adjust') {
          return res.status(409).json({ error: `The stock changed to ${item.quantity || 0} while you were counting. Check the count again.` });
        }
        return res.status(400).json({ error: `Insufficient quantity in stock. Only ${item.quantity || 0} available.` });
      });
    }

    const newQty = row.quantity;
    // add/subtract keep a positive quantity and the type gives the direction; an adjustment
    // stores the signed difference the count made.
    const txQty = type === 'adjust' ? change : Math.abs(change);
    db.run(
      'INSERT INTO consumable_transactions (consumableId, type, quantity, reason, performedBy) VALUES (?, ?, ?, ?, ?)',
      [id, type, txQty, reason || null, performedBy],
      function (err3) {
        if (err3) {
          // Put the stock back, so it never moves without a history row.
          db.run('UPDATE consumables SET quantity = quantity - ? WHERE id = ?', [change, id]);
          return res.status(500).json({ error: err3.message });
        }
        logAudit(req, `consumable.stock_${type}`, 'consumable', id, { change, newQuantity: newQty });
        res.json({
          success: true,
          previousQuantity: newQty - change,
          newQuantity: newQty,
          transactionId: this.lastID
        });
      }
    );
  });
});

// Get transaction history for a consumable
app.get('/consumables/:id/transactions', (req, res) => {
  const { id } = req.params;
  db.all(
    'SELECT * FROM consumable_transactions WHERE consumableId = ? ORDER BY createdAt DESC, id DESC',
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// The store log, newest first: every stock movement (consumable_transactions) and every item
// added, edited, archived or restored (audit_log). An added item's row carries its opening stock,
// so the separate "opening" stock row is left out. Optional ?from=<ISO time> starts it at a date.
// action is add | subtract | adjust (stock) or created | updated | archived | restored (item).
app.get('/consumables/log', (req, res) => {
  const from = req.query.from || null;
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 2000));
  db.all(
    `SELECT * FROM (
       SELECT 'stock' AS kind, t.id AS seq, t.createdAt AS time, t.consumableId AS itemId, c.name AS itemName,
              c.category, t.type AS action, t.quantity, t.reason, t.performedBy AS user
       FROM consumable_transactions t
       LEFT JOIN consumables c ON c.id = t.consumableId
       WHERE t.type <> 'opening'
       UNION ALL
       SELECT 'item', a.id, a.timestamp, a.entity_id, c.name, c.category,
              substr(a.action, 12), json_extract(a.details_json, '$.openingStock'), NULL, a.user_email
       FROM audit_log a
       LEFT JOIN consumables c ON c.id = a.entity_id
       WHERE a.entity_type = 'consumable'
         AND a.action IN ('consumable.created', 'consumable.updated', 'consumable.archived', 'consumable.restored')
     )
     WHERE ? IS NULL OR time >= datetime(?)
     -- Times are to the second: within one second, an item's creation comes first, then rows
     -- in the order they were written
     ORDER BY time DESC, (action = 'created') ASC, seq DESC
     LIMIT ?`,
    [from, from, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

/* --------------------------------- Scan ---------------------------------- */
app.post('/scan', (req, res) => {
  const target = (req.body?.target || '').trim();
  if (!target) return res.status(400).send('Target is required');

  const PY = process.env.PYTHON || 'python';
  const script = path.join(__dirname, 'scanner.py');
  const args = [script, '--target', target, '--api-url', `http://localhost:${PORT}`, '--dry-run', '--json'];

const child = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.on('error', (e) => res.status(500).send(`Spawn error: ${e.message}`));  let out = '', err = '';
  child.stdout.on('data', d => (out += d.toString()));
  child.stderr.on('data', d => (err += d.toString()));
  child.on('close', (code) => {
    if (code !== 0) return res.status(500).send(err || `Scanner exited with ${code}`);
    try {
      const list = JSON.parse(out);
      res.json(Array.isArray(list) ? list : []);
    } catch {
      res.status(500).send('Invalid scanner output');
    }
  });
});

app.get('/scan/stream', (req, res) => {
  const target = (req.query.target || '').trim();
  if (!target) return res.status(400).end('Target is required');

  const PY = process.env.PYTHON || 'python';
  const script = path.join(__dirname, 'scanner.py');
  const args = [script, '--target', target, '--api-url', `http://localhost:${PORT}`, '--dry-run', '--json'];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const child = spawn(PY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
  const keepAlive = setInterval(() => { res.write(':\n\n'); }, 20000);

  child.stderr.on('data', (d) => {
    String(d).split(/\r?\n/).forEach((line) => { if (line.trim()) send('log', line.trim()); });
  });
  child.stdout.on('data', (d) => { out += d.toString(); });

  child.on('close', (code) => {
    clearInterval(keepAlive);
    if (code !== 0) { send('error', `Scanner exited with code ${code}`); return res.end(); }
    try { send('result', JSON.stringify(JSON.parse(out || '[]'))); }
    catch (e) { send('error', `Invalid JSON: ${e.message}`); }
    res.end();
  });

  req.on('close', () => {
    clearInterval(keepAlive);
    try { child.kill(); } catch {}
  });
});

/* ------------------------------ Audit Log API ----------------------------- */
app.get('/audit-log', (req, res) => {
  const limit      = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const entityType = req.query.entity_type || null;
  const params     = entityType ? [entityType, limit] : [limit];
  const where      = entityType ? `WHERE entity_type = ?` : '';
  db.all(
    `SELECT id, timestamp, user_email, action, entity_type, entity_id, details_json, ip_address
     FROM audit_log ${where} ORDER BY id DESC LIMIT ?`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details_json || '{}') })));
    }
  );
});

/* ----------- Duplicate serial-number check (used by add/edit form) ----------- */
app.get('/assets/check-duplicate', (req, res) => {
  const serial    = (req.query.serialNumber || '').trim();
  const excludeId = (req.query.excludeId   || '').trim();
  if (!serial) return res.json({ exists: false });
  const sql    = excludeId
    ? `SELECT assetId FROM assets WHERE serialNumber = ? AND assetId != ? LIMIT 1`
    : `SELECT assetId FROM assets WHERE serialNumber = ? LIMIT 1`;
  const params = excludeId ? [serial, excludeId] : [serial];
  db.get(sql, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ exists: !!row, assetId: row?.assetId ?? null });
  });
});

/* -------------------------- Images upload API -------------------------- */
const imagesDir = dataPaths.imagesDir;
fs.mkdirSync(imagesDir, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagesDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.params.assetId}-${Date.now()}${ext}`);
  }
});

const uploadImageOnly = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  }
});

app.post('/assets/:assetId/image', uploadImageOnly.single('file'), (req, res) => {
  const { assetId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const imageUrl = `/uploads/images/${req.file.filename}`;
  db.run(
    `INSERT INTO asset_images (assetId, url) VALUES (?, ?)`,
    [assetId, imageUrl],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      const rowId = this.lastID;
      res.json({ url: imageUrl, id: rowId, ocrText: null });

      // Run OCR in background — does not block the upload response
      const absPath = path.join(imagesDir, req.file.filename);
      ocrImage(absPath).then(ocrText => {
        if (ocrText) {
          db.run(
            `UPDATE asset_images SET ocrText = ? WHERE id = ?`,
            [ocrText, rowId],
            (e) => { if (e) console.error('OCR DB update error:', e.message); }
          );
        }
      });
    }
  );
});

app.get('/assets/:assetId/images', (req, res) => {
  const { assetId } = req.params;
  db.all(
    `SELECT id, url, uploadedAt, ocrText FROM asset_images WHERE assetId = ? ORDER BY uploadedAt ASC, id ASC`,
    [assetId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ images: rows || [] });
    }
  );
});

app.delete('/assets/:assetId/images/:imageId', (req, res) => {
  const { assetId, imageId } = req.params;
  if (req.query.confirm !== 'true') return res.status(400).json({ error: 'confirm=true required' });
  db.get(
    `SELECT url FROM asset_images WHERE id = ? AND assetId = ?`,
    [imageId, assetId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Image not found' });
      const filename = path.basename(row.url);
      const absPath  = path.join(imagesDir, filename);
      db.run(`DELETE FROM asset_images WHERE id = ? AND assetId = ?`, [imageId, assetId], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        fs.unlink(absPath, () => {});
        res.json({ deleted: true });
      });
    }
  );
});

/* ---------------------- Document archive (documents.js) ---------------------- */
registerDocumentRoutes(app, { db, documentsDir: dataPaths.documentsDir, tessdataDir: TESSDATA_DIR, logAudit });

/* --------- SPA catch-all: authenticated users navigating directly to a route --- */
if (fs.existsSync(BUILD_DIR)) {
  app.get(/.*/, (req, res) => res.sendFile(path.join(BUILD_DIR, 'index.html')));
}

/* --------------------------------- Start --------------------------------- */
dedupeAndIndex((err) => {
  if (err) {
    console.error('Dedupe/Index error:', err);
    process.exit(1);
  }
  ensureInvoiceColumn((err2) => {
    if (err2) {
      console.error('Migration error (invoiceUrl):', err2);
      process.exit(1);
    }
    ensureHostNameColumn((err3) => {
      if (err3) {
        console.error('Migration error (hostName):', err3);
        process.exit(1);
      }
      ensureDepartmentColumn((err4) => {
        if (err4) {
          console.error('Migration error (department):', err4);
          process.exit(1);
        }
        ensureInvoicesTable((err5) => {
          if (err5) {
            console.error('Migration error (asset_invoices):', err5);
            process.exit(1);
          }
          ensureAuditLogTable((err6) => {
            if (err6) {
              console.error('Migration error (audit_log):', err6);
              process.exit(1);
            }
            ensureImagesTable((err7) => {
              if (err7) {
                console.error('Migration error (asset_images):', err7);
                process.exit(1);
              }
              ensureOcrColumn((err8) => {
                if (err8) {
                  console.error('Migration error (ocrText column):', err8);
                  process.exit(1);
                }
                ensureLabeledColumn((err9) => {
                  if (err9) {
                    console.error('Migration error (labeled column):', err9);
                    process.exit(1);
                  }
                  app.listen(PORT, '0.0.0.0', () => {
                    console.log(`✅ Server running on port ${PORT} (listening on 0.0.0.0)`);
                    console.log(`Data folder: ${dataPaths.dataDir}${dataPaths.fromEnv ? ' (DATA_DIR)' : ''}`);
                    if (_tesseractCreateWorker) {
                      console.log('🔍 OCR enabled (tesseract.js) — language data will download on first use');
                    } else {
                      console.log('⚠️  OCR disabled (tesseract.js not found)');
                    }
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
