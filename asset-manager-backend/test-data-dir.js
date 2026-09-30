// test-data-dir.js: checks DATA_DIR handling (dataDir.js and its use in index.js) without starting
// the server. Everything it writes goes to a temp folder that it removes at the end.
//
//   cd asset-manager-backend
//   node test-data-dir.js
//
// Needs the backend's node_modules (npm install) for the sqlite3 and dotenv checks.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveDataPaths, checkDataDir } = require('./dataDir');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fas-data-dir-'));
const touch = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

async function main() {
  /* ---- 1. DATA_DIR unset: the same paths index.js used before ---- */
  for (const env of [{}, { DATA_DIR: '' }, { DATA_DIR: '   ' }]) {
    const p = resolveDataPaths(env);
    const label = `DATA_DIR ${JSON.stringify(env.DATA_DIR)}`;
    check(`${label}: assets.db in the backend folder`, p.dbPath === path.resolve(__dirname, 'assets.db'), p.dbPath);
    check(`${label}: /uploads served from the backend folder`, p.uploadsDir === path.resolve(__dirname, 'uploads'), p.uploadsDir);
    check(`${label}: images path unchanged`, p.imagesDir === path.resolve(__dirname, 'uploads', 'images'), p.imagesDir);
    check(`${label}: invoices path unchanged`, p.invoicesDir === path.resolve(__dirname, 'uploads', 'invoices'), p.invoicesDir);
    check(`${label}: not marked as from .env`, p.fromEnv === false);
  }

  /* ---- 2. DATA_DIR set: everything comes from it ---- */
  const dataDir = path.join(tmp, 'data', 'FAS');
  {
    const p = resolveDataPaths({ DATA_DIR: dataDir });
    check('DATA_DIR set: assets.db from it', p.dbPath === path.join(dataDir, 'assets.db'), p.dbPath);
    check('DATA_DIR set: uploads from it', p.uploadsDir === path.join(dataDir, 'uploads'), p.uploadsDir);
    check('DATA_DIR set: images from it', p.imagesDir === path.join(dataDir, 'uploads', 'images'), p.imagesDir);
    check('DATA_DIR set: invoices from it', p.invoicesDir === path.join(dataDir, 'uploads', 'invoices'), p.invoicesDir);
    const rel = resolveDataPaths({ DATA_DIR: '../fas-data' });
    check('relative DATA_DIR is taken from the backend folder, not the working folder',
      rel.dataDir === path.resolve(__dirname, '..', 'fas-data'), rel.dataDir);
  }

  /* ---- 3. The guard, on a fake backend folder ---- */
  // Laid out like the server, <apps>\FAS\asset-manager-backend, so the shared data folder the
  // guard looks for is tmp\apps\data\FAS. The DATA_DIR used here, tmp\data\FAS, is elsewhere.
  const backend = path.join(tmp, 'apps', 'FAS', 'asset-manager-backend');
  const sharedDir = path.join(tmp, 'apps', 'data', 'FAS');
  fs.mkdirSync(backend, { recursive: true });

  {
    const p = resolveDataPaths({ DATA_DIR: dataDir }, backend);
    const r = checkDataDir(p);
    check('guard refuses when DATA_DIR has no assets.db', Boolean(r.error));
    check('refusal says where it looked', r.error && r.error.includes(path.join(dataDir, 'assets.db')), r.error);
    check('refusal says how to fix it', r.error && r.error.includes('Move the data first') && r.error.includes('DATA_DIR line'), r.error);
    check('guard did not create assets.db', !fs.existsSync(p.dbPath));
    check('guard did not create DATA_DIR', !fs.existsSync(dataDir));
  }

  touch(path.join(backend, 'assets.db'));
  {
    const r = checkDataDir(resolveDataPaths({ DATA_DIR: dataDir }, backend));
    check('refusal points at the database left in the code folder',
      r.error && r.error.includes(`still at: ${path.join(backend, 'assets.db')}`), r.error);
  }

  {
    const r = checkDataDir(resolveDataPaths({ DATA_DIR: path.join(tmp, 'elsewhere') }, backend));
    check('a DATA_DIR that does not exist at all is refused too', Boolean(r.error));
  }

  touch(path.join(dataDir, 'assets.db'));
  touch(path.join(backend, 'uploads', 'invoices', 'A-1.pdf'));
  touch(path.join(backend, 'uploads', 'invoices', 'A-2.pdf'));
  {
    const r = checkDataDir(resolveDataPaths({ DATA_DIR: dataDir }, backend));
    check('guard lets FAS start once assets.db is in DATA_DIR', r.error === null, r.error);
    check('warns that the old assets.db is not used',
      r.warnings.some(w => w.includes(path.join(backend, 'assets.db')) && w.includes('NOT used')), r.warnings.join(' | '));
    check('warns about invoices left in the old uploads folder',
      r.warnings.some(w => w.startsWith('2 file(s)') && w.includes(path.join(backend, 'uploads', 'invoices'))), r.warnings.join(' | '));
    check('warns that DATA_DIR has no uploads folder',
      r.warnings.some(w => w.includes(path.join(dataDir, 'uploads')) && w.includes('does not exist')), r.warnings.join(' | '));
  }

  {
    // The warning above says to remove the old file, so it must not be the one with the newest writes.
    const oldDb = path.join(backend, 'assets.db');
    const newDb = path.join(dataDir, 'assets.db');
    const at = s => fs.utimesSync(oldDb, s, s);
    const base = Math.floor(Date.now() / 1000) - 3600;
    fs.utimesSync(newDb, base, base);
    const guard = () => checkDataDir(resolveDataPaths({ DATA_DIR: dataDir }, backend));

    at(base + 600);
    const newer = guard();
    check('guard refuses when the old assets.db was written after the DATA_DIR one', Boolean(newer.error), newer.warnings.join(' | '));
    check('that refusal names both files', newer.error && newer.error.includes(oldDb) && newer.error.includes(newDb), newer.error);

    at(base);
    const same = guard();
    check('a copy that kept the last-write time only warns',
      same.error === null && same.warnings.some(w => w.includes('NOT used')), same.error);
    at(base + 1);
    const slack = guard();
    check('a gap within 2 s (file system rounding) only warns', slack.error === null, slack.error);
    at(base - 600);
    const older = guard();
    check('an old assets.db older than the DATA_DIR one only warns', older.error === null, older.error);
  }

  fs.rmSync(path.join(backend, 'assets.db'));
  fs.rmSync(path.join(backend, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads', 'images'), { recursive: true });
  {
    const r = checkDataDir(resolveDataPaths({ DATA_DIR: dataDir }, backend));
    check('a clean move gives no error and no warnings', r.error === null && r.warnings.length === 0, r.warnings.join(' | '));
  }

  {
    const r = checkDataDir(resolveDataPaths({}, backend));
    check('DATA_DIR unset with no assets.db: still starts, as before', r.error === null);
    check('DATA_DIR unset with no assets.db: says a new empty database is being created',
      r.warnings.some(w => w.includes('new empty database')), r.warnings.join(' | '));
    touch(path.join(backend, 'assets.db'));
    const r2 = checkDataDir(resolveDataPaths({}, backend));
    check('DATA_DIR unset with assets.db present: silent, as before', r2.error === null && r2.warnings.length === 0);
  }

  /* ---- 3b. DATA_DIR line lost from a remade .env after a restore ---- */
  {
    fs.rmSync(path.join(backend, 'assets.db'));
    const sharedDb = path.join(sharedDir, 'assets.db');
    touch(sharedDb);
    const p = resolveDataPaths({}, backend);
    check('the shared data folder is found beside the app folders', p.sharedDbPath === sharedDb, p.sharedDbPath);
    const r = checkDataDir(p);
    check('DATA_DIR unset, no assets.db here, one in the shared data folder: refuses', Boolean(r.error), r.warnings.join(' | '));
    check('that refusal names the shared database and the DATA_DIR line to add',
      r.error && r.error.includes(sharedDb) && r.error.includes(`DATA_DIR=${sharedDir}`), r.error);
    check('that refusal did not create assets.db in the code folder', !fs.existsSync(path.join(backend, 'assets.db')));

    touch(path.join(backend, 'assets.db'));
    const r2 = checkDataDir(resolveDataPaths({}, backend));
    check('DATA_DIR unset with assets.db here and in the shared folder: starts as before, warns the shared one is not used',
      r2.error === null && r2.warnings.some(w => w.includes(sharedDb) && w.includes('NOT used')), r2.error || r2.warnings.join(' | '));

    if (process.platform === 'win32') {
      const s = resolveDataPaths({}, 'E:\\Apps\\FAS\\asset-manager-backend').sharedDbPath;
      check('server layout: E:\\Apps\\FAS\\asset-manager-backend looks in E:\\Apps\\data\\FAS',
        s === 'E:\\Apps\\data\\FAS\\assets.db', s);
    }
  }

  /* ---- 4. index.js takes every data path from dataDir.js, and checks before opening ---- */
  {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    check('index.js opens dataPaths.dbPath', /const dbPath = dataPaths\.dbPath;/.test(src));
    check('index.js serves /uploads from DATA_DIR', src.includes("app.use('/uploads', express.static(dataPaths.uploadsDir))"));
    check('index.js writes invoices to DATA_DIR', src.includes('const invoicesDir = dataPaths.invoicesDir;'));
    check('index.js writes images to DATA_DIR', src.includes('const imagesDir = dataPaths.imagesDir;'));
    check('index.js has no data path left on __dirname',
      !/__dirname,\s*'(assets\.db|uploads)'/.test(src));
    const guardAt = src.indexOf('checkDataDir(dataPaths)');
    const exitAt = src.indexOf('process.exit(1)', guardAt);
    const openAt = src.indexOf('new sqlite3.Database(');
    check('index.js runs the guard and exits before opening the database',
      guardAt > 0 && exitAt > guardAt && openAt > exitAt);
    check('index.js sets a 5 s busy timeout right after opening',
      /new sqlite3\.Database\(dbPath\);[\s\S]{0,800}?db\.configure\('busyTimeout', 5000\);/.test(src));
  }

  /* ---- 5. dotenv keeps a Windows path as written ---- */
  {
    const dotenv = require('dotenv');
    const v = dotenv.parse('DATA_DIR=E:\\Apps\\data\\FAS\n').DATA_DIR;
    check('dotenv reads DATA_DIR=E:\\Apps\\data\\FAS unchanged', v === 'E:\\Apps\\data\\FAS', v);
  }

  /* ---- 6. What the 5 s busy timeout buys against a reader such as the backup tool ---- */
  await busyTimeoutCheck();
}

// A reader holds a read lock for 2 s, as a backup copy might. A write on a connection with
// node-sqlite3's default 1 s timeout fails with SQLITE_BUSY; with 5 s it waits and succeeds.
async function busyTimeoutCheck() {
  const sqlite3 = require('sqlite3');
  const file = path.join(tmp, 'busy.db');
  const open = () => new sqlite3.Database(file);
  const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, e => (e ? rej(e) : res())));
  const get = (db, sql) => new Promise((res, rej) => db.get(sql, (e, row) => (e ? rej(e) : res(row))));
  const close = db => new Promise(res => db.close(() => res()));

  const setup = open();
  await run(setup, 'CREATE TABLE sessions (sid TEXT PRIMARY KEY, data TEXT, expires INTEGER)');
  await close(setup);

  async function writeWhileRead(configure) {
    const reader = open();
    await run(reader, 'BEGIN');
    await get(reader, 'SELECT count(*) AS n FROM sessions'); // takes the shared lock
    const release = new Promise(res => setTimeout(() => run(reader, 'COMMIT').then(res), 2000));

    const writer = open();
    if (configure) writer.configure('busyTimeout', 5000);
    const t0 = Date.now();
    let err = null;
    try {
      await run(writer, 'INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)', [`s${t0}`, '{}', t0]);
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    await release;
    await close(reader);
    await close(writer);
    return { err, ms };
  }

  const dflt = await writeWhileRead(false);
  check('default 1 s timeout: the write fails with SQLITE_BUSY under a 2 s read',
    dflt.err && dflt.err.code === 'SQLITE_BUSY', dflt.err ? dflt.err.code : `succeeded after ${dflt.ms} ms`);

  const five = await writeWhileRead(true);
  check('5 s timeout: the same write waits for the reader and succeeds',
    !five.err && five.ms >= 1500, five.err ? five.err.code : `took ${five.ms} ms`);
}

main()
  .catch(e => { failed++; console.log(`FAIL  unexpected error: ${e.stack || e}`); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp folder, leave it */ }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
  });
