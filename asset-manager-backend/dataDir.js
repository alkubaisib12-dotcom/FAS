// dataDir.js: where FAS keeps its live data (assets.db and the uploaded images and invoices).
//
// On SWAPP, Veeam backs up only the shared data folder (E:\Apps\data), not the code folders,
// so the live data moves out of this folder into DATA_DIR, set in asset-manager-backend\.env.
// With DATA_DIR unset everything stays in this folder, exactly as before.
// tessdata is not live data (tesseract.js downloads it again when it is missing), so it stays here.

const path = require('path');
const fs = require('fs');

function resolveDataPaths(env = process.env, backendDir = __dirname) {
  const raw = (env.DATA_DIR || '').trim();
  // A relative DATA_DIR is taken from this folder, like the .env itself, not from
  // whatever folder the service happened to be started in.
  const dataDir = raw ? path.resolve(backendDir, raw) : path.resolve(backendDir);
  const uploadsDir = path.join(dataDir, 'uploads');
  return {
    fromEnv: Boolean(raw),
    backendDir: path.resolve(backendDir),
    dataDir,
    dbPath: path.join(dataDir, 'assets.db'),
    uploadsDir,
    imagesDir: path.join(uploadsDir, 'images'),
    invoicesDir: path.join(uploadsDir, 'invoices'),
  };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function countFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).length; } catch { return 0; }
}

function samePath(a, b) {
  const norm = p => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// Runs before the database is opened, because sqlite3 creates a missing file: FAS would start
// on a new empty assets.db and people would carry on adding assets to it. Returns
// { error, warnings }; the caller prints them and refuses to start when error is set.
function checkDataDir(p) {
  const warnings = [];
  const oldDb = path.join(p.backendDir, 'assets.db');
  const moved = !samePath(p.dataDir, p.backendDir);

  if (!p.fromEnv) {
    // Unchanged behaviour: a first start creates assets.db here. Said out loud, because after a
    // restore the hand-made .env may have lost its DATA_DIR line.
    if (!isFile(oldDb)) {
      warnings.push(
        `No assets.db in ${p.backendDir}, so FAS is creating a new empty database there. ` +
        'If the FAS data was moved to a data folder, stop FAS and set DATA_DIR in ' +
        `${path.join(p.backendDir, '.env')} to that folder.`
      );
    }
    return { error: null, warnings };
  }

  if (!isFile(p.dbPath)) {
    const lines = [
      `FAS will not start: DATA_DIR is set to ${p.dataDir}, but there is no database there.`,
      `  Looked for: ${p.dbPath}`,
    ];
    if (moved && isFile(oldDb)) lines.push(`  The database is still at: ${oldDb}`);
    lines.push(
      moved
        ? `  Move the data first: with FAS stopped, move ${oldDb} and ${path.join(p.backendDir, 'uploads')} into ${p.dataDir}.`
        : '  Put assets.db there first.',
      `  Or remove the DATA_DIR line from ${path.join(p.backendDir, '.env')} to keep the data in the code folder.`
    );
    return { error: lines.join('\n'), warnings };
  }

  if (moved) {
    if (isFile(oldDb)) {
      warnings.push(
        `An old assets.db is still at ${oldDb}. It is NOT used: FAS reads ${p.dbPath}. ` +
        'Rename or remove the old one once the move is confirmed, so nobody restores or edits the wrong file.'
      );
    }
    for (const sub of ['images', 'invoices']) {
      const oldSub = path.join(p.backendDir, 'uploads', sub);
      const n = countFiles(oldSub);
      if (n > 0) {
        warnings.push(
          `${n} file(s) are still in ${oldSub}. They are NOT served: FAS serves ${path.join(p.uploadsDir, sub)}. ` +
          'Move any that are missing there.'
        );
      }
    }
  }

  if (!isDir(p.uploadsDir)) {
    warnings.push(
      `${p.uploadsDir} does not exist, so FAS starts with no uploaded images or invoices. ` +
      'If FAS had any, stop it and move the old uploads folder there.'
    );
  }

  return { error: null, warnings };
}

module.exports = { resolveDataPaths, checkDataDir };
