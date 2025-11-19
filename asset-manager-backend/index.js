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
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // secure: true,
  }
}));

// Static serving for uploads
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

/* ------------------------------ SQLite ---------------------------------- */
const dbPath = path.resolve(__dirname, 'assets.db');
const db = new sqlite3.Database(dbPath);

// Enable FK so ON DELETE CASCADE works
db.run('PRAGMA foreign_keys = ON');

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
  required INTEGER DEFAULT 0
)`);

db.run(`CREATE TABLE IF NOT EXISTS used_consumable_ids ( id TEXT PRIMARY KEY )`);

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

// Columns that actually exist on the `assets` table (include legacy invoiceUrl)
const ASSET_COLUMNS = new Set([
  'assetId','group','assetType','brandModel','serialNumber','assignedTo','hostName','department',
  'ipAddress','macAddress','osFirmware','cpu','ram','storage','portDetails',
  'powerConsumption','purchaseDate','warrantyExpiry','eol','maintenanceExpiry',
  'cost','depreciation','residualValue','status','condition','usagePurpose',
  'accessLevel','licenseKey','complianceStatus','documentation','remarks',
  'lastAuditDate','disposedDate','replacementPlan','invoiceUrl'
]);

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
    res.json({ ok: true, user: req.session.user });
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

/* --------------------------- Auth Guard (global) ------------------------- */
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

  if (!req.session?.user) return res.status(401).json({ error: 'Auth required' });
  next();
});

/* ------------------------------ Assets API ------------------------------- */
// include invoiceUrls[] (fallback to legacy invoiceUrl if present)
app.get('/assets', (req, res) => {
  const sql = `
    SELECT a.*,
           GROUP_CONCAT(ai.url, '||') AS __invoices
    FROM assets a
    LEFT JOIN asset_invoices ai ON ai.assetId = a.assetId
    GROUP BY a.assetId
    ORDER BY a.assetId
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const mapped = rows.map(r => {
      const arr = r.__invoices
        ? r.__invoices.split('||').filter(Boolean)
        : (r.invoiceUrl ? [r.invoiceUrl] : []);
      delete r.__invoices;
      return { ...r, invoiceUrls: arr };
    });
    res.json(mapped);
  });
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
    res.status(201).json({ id: asset.assetId, inserted: true });
  });
});

// Bulk add — normalization + counts inserted vs skipped
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

  const sql = `INSERT OR IGNORE INTO assets (
    assetId,"group",assetType,brandModel,serialNumber,hostName,assignedTo,department,ipAddress,macAddress,osFirmware,cpu,ram,storage,
    portDetails,powerConsumption,purchaseDate,warrantyExpiry,eol,maintenanceExpiry,cost,depreciation,residualValue,
    status,condition,usagePurpose,accessLevel,licenseKey,complianceStatus,documentation,remarks,lastAuditDate,disposedDate,replacementPlan
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  let insertedCount = 0;
  const insert = db.prepare(sql);

  db.serialize(() => {
    listNorm.forEach(a => {
      insert.run([
        a.assetId, a.group, a.assetType, a.brandModel, a.serialNumber, a.hostName, a.assignedTo, a.department, a.ipAddress, a.macAddress, a.osFirmware, a.cpu, a.ram, a.storage,
        a.portDetails, a.powerConsumption, a.purchaseDate, a.warrantyExpiry, a.eol, a.maintenanceExpiry, a.cost, a.depreciation, a.residualValue,
        a.status, a.condition, a.usagePurpose, a.accessLevel, a.licenseKey, a.complianceStatus, a.documentation, a.remarks, a.lastAuditDate, a.disposedDate, a.replacementPlan
      ], function (err) {
        if (err) return; // treat constraint as skip
        if (this.changes > 0) {
          insertedCount += 1;
          db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [a.assetId]);
        }
      });
    });
  });

  insert.finalize((err) => {
    if (err) return res.status(500).json({ error: err.message });
    const skipped = listNorm.length - insertedCount;
    res.json({ inserted: insertedCount, skipped });
  });
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
    db.serialize(() => {
      db.run('BEGIN');
      db.run(`DELETE FROM assets WHERE assetId = ?`, oldId, function (err) {
        if (err) return rollback(err, res);
        const sqlInsert = `INSERT INTO assets (${fields.join(',')}) VALUES (${placeholders})`;
        db.run(sqlInsert, Object.values(asset), function (err2) {
          if (err2) {
            const status = String(err2.code).includes('CONSTRAINT') ? 409 : 500;
            return rollback(err2, res, status);
          }
          db.run(`INSERT OR IGNORE INTO used_ids (assetId) VALUES (?)`, [asset.assetId], function (err3) {
            if (err3) return rollback(err3, res);
            db.run('COMMIT', () => res.json({ updated: 1 }));
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
      res.json({ updated: this.changes });
    });
  }
});

app.delete('/assets/:id', (req, res) => {
  db.run(`DELETE FROM assets WHERE assetId = ?`, req.params.id, function (err) {
    if (err) return res.status(500).json({ error: err.message });
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

// Public-read (scanner + UI) — next id
app.get('/assets/next-id/:type', (req, res) => {
  const rawType = req.params.type;
  if (!rawType || rawType.length < 2) return res.status(400).json({ error: 'Invalid asset type' });

  const safePrefix = rawType.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3);
  if (!safePrefix) return res.status(400).json({ error: 'Invalid asset type prefix' });

  db.all(`SELECT assetId FROM used_ids WHERE assetId LIKE '${safePrefix}-%'`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const numbers = rows
      .map(row => {
        const m = row.assetId.match(new RegExp(`^${safePrefix}-(\\d+)$`));
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(n => n !== null);
    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    res.json({ id: `${safePrefix}-${String(next).padStart(3, '0')}` });
  });
});

/* -------------------------- Invoices upload API -------------------------- */
const invoicesDir = path.resolve(__dirname, 'uploads', 'invoices');
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

/* ----------------------------- Consumables API --------------------------- */
// Get all consumables with custom fields merged
app.get('/consumables', (req, res) => {
  db.all('SELECT * FROM consumables ORDER BY id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(r => ({
      ...r,
      customFields: r.customFields ? JSON.parse(r.customFields) : {}
    }));
    res.json(parsed);
  });
});

// Get next consumable ID
app.get('/consumables/next-id', (req, res) => {
  db.all(`SELECT id FROM used_consumable_ids WHERE id LIKE 'CONS-%'`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const numbers = rows
      .map(row => {
        const m = row.id.match(/^CONS-(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(n => n !== null);
    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    res.json({ id: `CONS-${String(next).padStart(3, '0')}` });
  });
});

// Add new consumable
app.post('/consumables', (req, res) => {
  const { id, name, quantity, company, customFields } = req.body;

  if (!id || !name) {
    return res.status(400).json({ error: 'ID and name are required' });
  }

  const customFieldsJson = customFields ? JSON.stringify(customFields) : null;
  const sql = `INSERT INTO consumables (id, name, quantity, company, customFields) VALUES (?, ?, ?, ?, ?)`;

  db.run(sql, [id, name, quantity || 0, company || null, customFieldsJson], function (err) {
    if (err) {
      const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
      return res.status(status).json({ error: err.message });
    }
    db.run(`INSERT OR IGNORE INTO used_consumable_ids (id) VALUES (?)`, [id]);
    res.status(201).json({ id, inserted: true });
  });
});

// Update consumable
app.put('/consumables/:id', (req, res) => {
  const { id } = req.params;
  const { name, quantity, company, customFields } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const customFieldsJson = customFields ? JSON.stringify(customFields) : null;
  const sql = `UPDATE consumables SET name = ?, quantity = ?, company = ?, customFields = ?, updatedAt = datetime('now') WHERE id = ?`;

  db.run(sql, [name, quantity || 0, company || null, customFieldsJson, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

// Delete consumable
app.delete('/consumables/:id', (req, res) => {
  db.run(`DELETE FROM consumables WHERE id = ?`, req.params.id, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// Get custom fields
app.get('/consumables/fields', (req, res) => {
  db.all('SELECT * FROM consumable_custom_fields ORDER BY fieldName', [], (err, rows) => {
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

  const sql = `INSERT INTO consumable_custom_fields (fieldName, fieldType, required) VALUES (?, ?, ?)`;

  db.run(sql, [fieldName, fieldType, required ? 1 : 0], function (err) {
    if (err) {
      const status = String(err.code).includes('CONSTRAINT') ? 409 : 500;
      return res.status(status).json({ error: err.message });
    }
    res.status(201).json({ fieldName, added: true });
  });
});

// Delete custom field
app.delete('/consumables/fields/:fieldName', (req, res) => {
  db.run(`DELETE FROM consumable_custom_fields WHERE fieldName = ?`, req.params.fieldName, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
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
          app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server running on port ${PORT} (listening on 0.0.0.0)`);
          });
        });
      });
    });
  });
});
