#!/usr/bin/env node
// scripts/link-assignees.js
//
// Ties every asset's old typed "Assigned To" to an Active Directory person or to a place, once,
// after the update that added people.js.
//
// WHY
// The 2026-11-12 audit found 379 different typed values for 691 assets, 267 of them naming 158
// people in two or three spellings each. From now on the form only picks a person or a place;
// this script brings the old values over. It changes a value by itself only when the match is
// certain, and everything else only as the review sheet says. Nothing is guessed.
//
// Certain (changed without a decision, unless the sheet says "no"):
//   - the value is exactly an AD login ("a.alkubaesy", "SWD\a.alkubaesy")
//   - the value has the same letters as the AD name of exactly one account, and no other
//     account has the same first and family name
//   - the value holds exactly one AD login and the name beside it has that account's first and
//     family name ("Zayed Matar z.matar")
// Everything else is marked "not linked" (assigneeKind 'text'), kept exactly as typed, and
// listed in the asset list's "Holder not linked" filter, unless the sheet decides it.
//
// The review sheet (assignee-review.csv, from the audit): the "Your decision" column, per value:
//   (empty)            certain values are linked, the rest stay as typed (not linked)
//   yes                the person in the sheet's "AD login" column
//   <login>            that AD person, e.g. a.alkubaesy
//   place              a place named exactly as the value (created if not in the list)
//   place: <name>      that place (matched to an existing one with the same letters, or created)
//   clear              nobody
//   remark             adds "Assigned To was: <value>" to Remarks, and clears the holder
//   keep / no          stays as typed (not linked), even when it would be certain
//   Several at once with ";", e.g.  remark; place: Old IT Store
//
//   node scripts/link-assignees.js [sheet.csv]            dry run: prints every change, writes nothing
//   node scripts/link-assignees.js [sheet.csv] --apply    writes, in one transaction
//   --db <path>                                           another assets.db (a copy, for a test)
//
// Order of use on the server: update and restart FAS; sign in once (FAS reads AD at sign-in);
// dry run; read it; --apply; dry run again (it should say nothing is left to change).
// The dry run opens the database read-only.

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env'), quiet: true });
const sqlite3 = require(path.join(BACKEND, 'node_modules', 'sqlite3'));
const { resolveDataPaths } = require(path.join(BACKEND, 'dataDir'));
const { squash, bareLogin } = require(path.join(BACKEND, 'people'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbFlag = args.indexOf('--db');
const DB_PATH = dbFlag >= 0 ? path.resolve(args[dbFlag + 1]) : resolveDataPaths().dbPath;
const SHEET = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db') || null;

/* ---------------------------- CSV (quote-aware) ---------------------------- */
// Excel saves a CSV with ";" between cells on some regional settings, so the header line decides.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  text = text.replace(/^﻿/, '');
  const firstLine = text.split('\n', 1)[0];
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

function readSheet(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (name) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`The sheet has no "${name}" column (found: ${head.join(', ')})`);
    return i;
  };
  const iValue = col('current assigned to'), iLogin = col('ad login'), iDecision = col('your decision'), iLevel = col('level');
  const out = new Map();
  for (const r of rows) {
    const value = r[iValue] ?? '';
    if (!value.trim()) continue;
    out.set(value, { level: r[iLevel] || '', login: (r[iLogin] || '').trim(), decision: (r[iDecision] || '').trim() });
  }
  return out;
}

/* ------------------------------ Certain match ------------------------------ */
const TITLES = new Set(['shk', 'sh', 'shaikh', 'sheikh', 'dr', 'eng', 'mr']);
const tokens = (s) => String(s || '').replace(/\(.*?\)/g, ' ').split(/\s+/)
  .filter((t) => t && !/^[a-z]\.\S+$/i.test(t))
  .map((t) => t.replace(/[^A-Za-z]/g, '').toLowerCase())
  .filter((t) => t.length > 1 && !TITLES.has(t));
const fam = (t) => t.replace(/^(al|el)/, '');
const firstLast = (s) => { const t = tokens(s); return t.length >= 2 ? [t[0], fam(t[t.length - 1])] : null; };
const sameFL = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

function certainMatch(value, people) {
  const raw = value.trim();
  const byLogin = new Map(people.map((p) => [p.login.toLowerCase(), p]));
  const exact = byLogin.get(bareLogin(raw).toLowerCase());
  if (exact) return { person: exact, why: 'is exactly this AD login' };

  const twinFree = (p) => !people.some((o) => o !== p && sameFL(firstLast(o.name), firstLast(p.name)));
  const named = people.filter((p) => squash(p.name) === squash(raw));
  if (named.length === 1 && twinFree(named[0])) return { person: named[0], why: 'has the same letters as the AD name' };

  const logins = raw.split(/[\s,]+/).filter((t) => /[.\-]/.test(t) && byLogin.has(t.toLowerCase()));
  if (logins.length === 1 && !raw.includes(',')) {
    const p = byLogin.get(logins[0].toLowerCase());
    if (sameFL(firstLast(raw), firstLast(p.name))) return { person: p, why: 'holds this AD login, and the name beside it agrees' };
  }
  return null;
}

/* ---------------------------------- Main ---------------------------------- */
function open(mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, mode, (e) => (e ? reject(e) : resolve(db)));
  });
}
const q = (db, fn) => (sql, params = []) => new Promise((resolve, reject) =>
  db[fn](sql, params, function (e, r) { if (e) reject(e); else resolve(fn === 'run' ? this : r); }));

(async () => {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database at ${DB_PATH}`);
  const db = await open(APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
  db.configure('busyTimeout', 5000);
  const all = q(db, 'all'), get = q(db, 'get'), run = q(db, 'run');

  const cols = (await all(`PRAGMA table_info(assets)`)).map((c) => c.name);
  if (!cols.includes('assigneeKind')) throw new Error('assets has no assigneeKind column: start the updated FAS once first.');
  if (!(await get(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'holder_changes'`))) {
    throw new Error('No holder_changes table: start the updated FAS once first.');
  }
  const people = await all(`SELECT login, name, disabled, inAd FROM ad_people`);
  if (people.length < 20) {
    throw new Error(`FAS knows only ${people.length} AD accounts. Sign in to FAS once after the update (FAS reads AD at sign-in), then run this again.`);
  }
  const byLogin = new Map(people.map((p) => [p.login.toLowerCase(), p]));
  const places = await all(`SELECT id, name, archived FROM places`);
  const sheet = SHEET ? readSheet(SHEET) : new Map();

  const values = await all(`SELECT assignedTo AS v, COUNT(*) AS n FROM assets
                            WHERE TRIM(COALESCE(assignedTo, '')) <> '' AND COALESCE(assigneeKind, '') IN ('', 'text')
                            GROUP BY assignedTo ORDER BY assignedTo COLLATE NOCASE`);

  const plan = []; const problems = [];
  for (const { v, n } of values) {
    const row = sheet.get(v);
    const steps = (row?.decision || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    const p = { value: v, assets: n, holder: null, remark: false, why: '' };
    const auto = certainMatch(v, people);

    if (!steps.length) {
      if (auto) Object.assign(p, { holder: { kind: 'person', person: auto.person }, why: `certain: ${auto.why}` });
      else p.why = 'no decision: stays as typed (not linked)';
    }
    for (const s of steps) {
      const low = s.toLowerCase();
      if (low === 'keep' || low === 'no') { p.holder = null; p.why = 'sheet: keep as typed'; }
      else if (low === 'clear') { p.holder = { kind: 'none' }; p.why = 'sheet: clear'; }
      else if (low === 'remark') { p.remark = true; if (!p.holder) p.holder = { kind: 'none' }; p.why = p.why || 'sheet: remark'; }
      else if (low === 'yes') {
        const person = row.login && byLogin.get(row.login.toLowerCase());
        if (!person) problems.push(`"${v}": "yes" but the sheet's AD login "${row.login}" is not an AD account FAS knows`);
        else { p.holder = { kind: 'person', person }; p.why = 'sheet: yes'; }
      } else if (low === 'place' || low.startsWith('place:')) {
        const name = (low === 'place' ? v : s.slice(s.indexOf(':') + 1)).replace(/\s+/g, ' ').trim();
        if (!name) problems.push(`"${v}": "place:" with no name`);
        else { p.holder = { kind: 'place', name }; p.why = `sheet: place "${name}"`; }
      } else if (byLogin.has(bareLogin(s).toLowerCase())) {
        p.holder = { kind: 'person', person: byLogin.get(bareLogin(s).toLowerCase()) }; p.why = `sheet: ${s}`;
      } else {
        problems.push(`"${v}": decision "${s}" is not yes, keep, no, clear, remark, place, place: <name>, or an AD login FAS knows`);
      }
    }
    plan.push(p);
  }

  // Report
  const link = plan.filter((p) => p.holder && p.holder.kind === 'person');
  const toPlace = plan.filter((p) => p.holder && p.holder.kind === 'place');
  const cleared = plan.filter((p) => p.holder && p.holder.kind === 'none');
  const kept = plan.filter((p) => !p.holder);
  const sum = (xs) => xs.reduce((s, p) => s + p.assets, 0);
  console.log(`Database: ${DB_PATH}${APPLY ? '' : ' (read-only, dry run)'}`);
  console.log(`Sheet:    ${SHEET || '(none: certain matches only)'}`);
  console.log(`AD accounts known to FAS: ${people.length}\n`);
  for (const p of link) {
    const d = p.holder.person;
    console.log(`  person  ${JSON.stringify(p.value)} (${p.assets}) -> ${d.login}  ${d.name}${d.disabled ? '  [disabled in AD]' : ''}${p.remark ? '  + remark' : ''}   [${p.why}]`);
  }
  for (const p of toPlace) console.log(`  place   ${JSON.stringify(p.value)} (${p.assets}) -> ${p.holder.name}${p.remark ? '  + remark' : ''}`);
  for (const p of cleared) console.log(`  clear   ${JSON.stringify(p.value)} (${p.assets})${p.remark ? '  + remark' : ''}`);
  console.log(`\nTo a person: ${link.length} values, ${sum(link)} assets`);
  console.log(`To a place:  ${toPlace.length} values, ${sum(toPlace)} assets`);
  console.log(`Cleared:     ${cleared.length} values, ${sum(cleared)} assets`);
  console.log(`Not linked:  ${kept.length} values, ${sum(kept)} assets (kept as typed)`);
  const unseen = [...sheet.keys()].filter((v) => !values.some((x) => x.v === v));
  if (unseen.length) console.log(`\nSheet rows with no unlinked asset now (already linked, or edited since): ${unseen.length}`);
  if (problems.length) {
    console.log(`\nProblems (${problems.length}): fix these in the sheet${APPLY ? '. Nothing was written.' : ''}`);
    for (const m of problems) console.log(`  ${m}`);
    if (APPLY) { db.close(); process.exit(1); }
  }
  if (!APPLY) { console.log('\nDry run: nothing written. Add --apply to write.'); db.close(); return; }

  // Write, in one transaction on this script's own connection
  const placeId = new Map(places.map((pl) => [squash(pl.name), pl.id]));
  await run('BEGIN IMMEDIATE');
  try {
    let changed = 0;
    const where = `assignedTo = ? AND COALESCE(assigneeKind, '') IN ('', 'text')`;
    for (const p of plan) {
      if (p.remark) {
        await run(`UPDATE assets SET remarks = TRIM(COALESCE(remarks, '') || CASE WHEN TRIM(COALESCE(remarks, '')) = '' THEN '' ELSE char(10) END || ?)
                   WHERE ${where}`, [`Assigned To was: ${p.value}`, p.value]);
      }
      // Holder history (people.js): one row per asset, from the typed text to who it is now.
      const history = (kind, key, name) => run(
        `INSERT INTO holder_changes (assetId, byUser, source, fromKind, fromKey, fromName, toKind, toKey, toName)
         SELECT assetId, 'link-assignees', 'link', assigneeKind, assigneeKey, assignedTo, ?, ?, ? FROM assets WHERE ${where}`,
        [kind, key, name, p.value]);
      let r;
      if (!p.holder) {
        r = await run(`UPDATE assets SET assigneeKind = 'text', assigneeKey = NULL WHERE ${where} AND COALESCE(assigneeKind, '') = ''`, [p.value]);
      } else if (p.holder.kind === 'person') {
        const d = p.holder.person;
        await history('person', d.login, d.name);
        r = await run(`UPDATE assets SET assigneeKind = 'person', assigneeKey = ?, assignedTo = ? WHERE ${where}`, [d.login, d.name, p.value]);
      } else if (p.holder.kind === 'place') {
        let id = placeId.get(squash(p.holder.name));
        if (!id) {
          id = (await run(`INSERT INTO places (name, createdBy) VALUES (?, 'link-assignees')`, [p.holder.name])).lastID;
          placeId.set(squash(p.holder.name), id);
        }
        const name = (await get(`SELECT name FROM places WHERE id = ?`, [id])).name;
        await history('place', String(id), name);
        r = await run(`UPDATE assets SET assigneeKind = 'place', assigneeKey = ?, assignedTo = ? WHERE ${where}`, [String(id), name, p.value]);
      } else {
        await history(null, null, null);
        r = await run(`UPDATE assets SET assigneeKind = NULL, assigneeKey = NULL, assignedTo = '' WHERE ${where}`, [p.value]);
      }
      if (r.changes && p.holder) {
        await run(`INSERT INTO audit_log (user_email, action, entity_type, entity_id, details_json, ip_address)
                   VALUES ('link-assignees', 'asset.holder_linked', 'asset', '', ?, 'script')`,
        [JSON.stringify({ from: p.value, to: p.holder.person?.login || p.holder.name || '', kind: p.holder.kind, assets: r.changes, why: p.why })]);
      }
      changed += r.changes;
    }
    await run('COMMIT');
    console.log(`\nWritten: ${changed} asset rows updated.`);
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    throw e;
  }
  db.close();
})().catch((e) => { console.error(`link-assignees: ${e.message}`); process.exit(1); });
