// dataDir.js: where FAS keeps its live data (assets.db and the uploaded images and invoices).
//
// On the production server, the server backup covers only the shared data folder, not the code
// folders, so the live data moves out of this folder into DATA_DIR, set in asset-manager-backend\.env.
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
    // Where the shared data folder layout puts the database: the data folder sits beside the
    // app folders, so <apps>\FAS\asset-manager-backend keeps its data in <apps>\data\FAS.
    // Only used to notice a lost DATA_DIR line, never read or written.
    sharedDbPath: path.resolve(backendDir, '..', '..', 'data', 'FAS', 'assets.db'),
  };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// Local time as YYYY-MM-DD HH:MM:SS, for messages an operator compares with Explorer.
function stamp(ms) {
  const d = new Date(ms);
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// A copy or a move keeps a file's last-write time, but FAT and some network shares round it to
// 2 s, so a copy's time can differ from its source's by up to 2 s. Only a larger gap counts.
const MTIME_SLACK_MS = 2000;

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
  const envFile = path.join(p.backendDir, '.env');

  if (!p.fromEnv) {
    const shared = p.sharedDbPath && isFile(p.sharedDbPath);
    if (!isFile(oldDb)) {
      // After a restore the code comes fresh from GitHub and .env is made again by hand, so the
      // DATA_DIR line is easy to lose. Without this check FAS would start on a new empty
      // assets.db while the real one sits in the shared data folder, and a warning in a service
      // log is as good as silent. Before the move that file does not exist, so a first start
      // still creates assets.db here as it always did.
      if (shared) {
        return {
          error: [
            `FAS will not start: DATA_DIR is not set and there is no assets.db in ${p.backendDir},`,
            `  but the FAS database is at: ${p.sharedDbPath}`,
            `  Set DATA_DIR=${path.dirname(p.sharedDbPath)} in ${envFile}, then start FAS again.`,
            '  Starting now would create a new empty database and leave that one unused.',
          ].join('\n'),
          warnings,
        };
      }
      warnings.push(
        `No assets.db in ${p.backendDir}, so FAS is creating a new empty database there. ` +
        'If the FAS data was moved to a data folder, stop FAS and set DATA_DIR in ' +
        `${envFile} to that folder.`
      );
    } else if (shared) {
      warnings.push(
        `A database is also at ${p.sharedDbPath}. It is NOT used: DATA_DIR is not set, so FAS reads ${oldDb}. ` +
        `If the data was moved there, stop FAS and set DATA_DIR in ${envFile}.`
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
      `  Or remove the DATA_DIR line from ${envFile} to keep the data in the code folder.`
    );
    return { error: lines.join('\n'), warnings };
  }

  if (moved) {
    if (isFile(oldDb)) {
      // The advice below is to remove the old file, which is only safe if it holds nothing the
      // DATA_DIR copy lacks. If FAS kept writing to it after it was copied (copied while FAS was
      // running, or FAS restarted without DATA_DIR mid-move), it is the newer one. FAS keeps
      // a rollback journal, not a WAL, so every commit updates assets.db's own last-write time,
      // and this code never touches the old file, so a clean move never trips this.
      const oldAt = mtimeMs(oldDb);
      const newAt = mtimeMs(p.dbPath);
      if (oldAt - newAt > MTIME_SLACK_MS) {
        return {
          error: [
            'FAS will not start: the old assets.db in the code folder was written after the one in DATA_DIR,',
            '  so it may hold changes that the DATA_DIR copy lacks.',
            `  Old:      ${oldDb} (last written ${stamp(oldAt)})`,
            `  DATA_DIR: ${p.dbPath} (last written ${stamp(newAt)})`,
            `  With FAS stopped, put the current one at ${p.dbPath} and rename the other one`,
            '  (for example to assets-old.db), then start FAS again.',
          ].join('\n'),
          warnings,
        };
      }
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
