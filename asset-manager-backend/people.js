// people.js: who holds an asset. Either a person, by their Active Directory login, or a place or
// group from FAS's own fixed list (Floor 7, Data Center Rack 1, IT Store).
//
// WHY
// assets.assignedTo used to be typed by hand, filled from ManageEngine's last logged-on user, or
// copied from an Excel sheet, so one person showed up as a login, as "Ahmed Alathari" and as
// "Ahmed AlAthari". The audit of 2026-11-12 found 267 different values for 158 people. Now:
//   assigneeKind  'person' | 'place' | 'text' | NULL (nobody)
//   assigneeKey   the AD login (person) or the places.id (place)
//   assignedTo    the name shown everywhere: AD's displayName or the place's name. The server
//                 writes it from the key, never from what a browser sent, so every screen,
//                 filter and export keeps reading assignedTo and gets the one standard name.
// 'text' is an old typed value that matched nobody for certain. It is kept as typed, shown as
// "not linked", and never guessed at: someone picks the person or place.
//
// The AD list (ad_people) is refreshed when someone from IT signs in, over the connection their
// own sign-in opened, so FAS needs no stored service-account password. Only IT signs in to FAS.

const PERSON = 'person';
const PLACE = 'place';
const TEXT = 'text';
const REFRESH_EVERY_MS = 10 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Letters only, lower case: "Ahmed AlAthari" and "ahmed  alathari" are the same text.
// Used for exact matches only, never for "close enough".
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "SWD\a.alkubaesy" or "a.alkubaesy@swd.bh" (ManageEngine, Excel) → "a.alkubaesy"
const bareLogin = (s) => String(s || '').trim().replace(/^[^\\]+\\/, '').replace(/@.*$/, '');

// ldapjs 3 search entries have no .object: read the attributes list.
function entryToObject(entry) {
  const o = {};
  for (const a of entry.attributes || []) {
    const vals = a.values || [];
    o[a.type] = vals.length > 1 ? vals : vals[0];
  }
  return o;
}

function createPeople({ db, logAudit }) {
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  /* ---- Tables and columns (in order; see the db.serialize note in index.js) ---- */
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ad_people (
      login TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT NOT NULL,
      email TEXT,
      department TEXT,
      title TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      inAd INTEGER NOT NULL DEFAULT 1,
      seenAt TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      archived INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      createdBy TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS ad_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      at TEXT, count INTEGER, byUser TEXT, error TEXT
    )`);
    for (const col of ['assigneeKind TEXT', 'assigneeKey TEXT']) {
      db.run(`ALTER TABLE assets ADD COLUMN ${col}`, (err) => {
        if (err && !String(err.message).includes('duplicate column')) {
          console.error(`Failed to add assets.${col.split(' ')[0]}:`, err.message);
        }
      });
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_assets_assignee ON assets(assigneeKind, assigneeKey)`);
    // Who held what, when: one row per change of holder. Lets a person's page show what they
    // hold now and held before, and an asset show who had it. Asset tools treat this custody
    // history as the record to trust when a device goes missing or someone leaves.
    db.run(`CREATE TABLE IF NOT EXISTS holder_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetId TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      byUser TEXT,
      source TEXT,
      fromKind TEXT, fromKey TEXT, fromName TEXT,
      toKind TEXT, toKey TEXT, toName TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_holder_changes_asset ON holder_changes(assetId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_holder_changes_to ON holder_changes(toKind, toKey)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_holder_changes_from ON holder_changes(fromKind, fromKey)`);
  });

  /* ------------------------------ AD refresh ------------------------------ */
  let refreshing = false;

  // client: an ldapjs client already bound as the person signing in. Always unbinds it.
  async function refreshFromLdap(client, baseDn, byUser) {
    const done = () => { try { client.unbind(); } catch {} };
    if (refreshing) return done();
    try {
      const last = await get(`SELECT at, error FROM ad_sync WHERE id = 1`);
      if (last?.at && !last.error && Date.now() - Date.parse(last.at) < REFRESH_EVERY_MS) return; // finally unbinds
      refreshing = true;

      const entries = await new Promise((resolve, reject) => {
        const out = [];
        client.search(baseDn, {
          scope: 'sub',
          filter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName=*))',
          attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title', 'userAccountControl'],
          paged: { pageSize: 500 },
        }, (err, res) => {
          if (err) return reject(err);
          res.on('searchEntry', (e) => out.push(entryToObject(e)));
          res.on('error', reject);
          res.on('end', () => resolve(out));
        });
      });
      const people = entries.filter((e) => e.sAMAccountName).map((e) => ({
        login: String(e.sAMAccountName),
        name: String(e.displayName || e.sAMAccountName).trim(),
        email: e.mail ? String(e.mail).toLowerCase() : null,
        department: e.department || null,
        title: e.title || null,
        disabled: (parseInt(e.userAccountControl, 10) & 2) ? 1 : 0,
      }));
      // An empty or tiny answer means the search went wrong, not that everyone left.
      if (people.length < 20) throw new Error(`AD returned only ${people.length} accounts`);

      // One statement per step and no BEGIN: FAS shares one connection, and a BEGIN meeting
      // another request's open transaction used to end the process (see index.js).
      // To the millisecond: "seenAt is not this stamp" is what marks an account as gone.
      const stamp = new Date().toISOString();
      await run(`INSERT INTO ad_people (login, name, email, department, title, disabled, inAd, seenAt)
                 SELECT json_extract(value, '$.login'), json_extract(value, '$.name'), json_extract(value, '$.email'),
                        json_extract(value, '$.department'), json_extract(value, '$.title'),
                        json_extract(value, '$.disabled'), 1, ?
                 FROM json_each(?) WHERE true
                 ON CONFLICT(login) DO UPDATE SET name = excluded.name, email = excluded.email,
                   department = excluded.department, title = excluded.title,
                   disabled = excluded.disabled, inAd = 1, seenAt = excluded.seenAt`,
      [stamp, JSON.stringify(people)]);
      // Accounts deleted from AD stay listed (assets may still point at them), marked as gone.
      await run(`UPDATE ad_people SET inAd = 0 WHERE seenAt IS NOT ?`, [stamp]);
      // A name corrected in AD reaches every asset that person holds.
      const renamed = await run(`UPDATE assets SET assignedTo = (SELECT name FROM ad_people WHERE login = assets.assigneeKey)
                 WHERE assigneeKind = 'person'
                   AND EXISTS (SELECT 1 FROM ad_people p WHERE p.login = assets.assigneeKey AND p.name <> COALESCE(assets.assignedTo, ''))`);
      await run(`INSERT INTO ad_sync (id, at, count, byUser, error) VALUES (1, ?, ?, ?, NULL)
                 ON CONFLICT(id) DO UPDATE SET at = excluded.at, count = excluded.count, byUser = excluded.byUser, error = NULL`,
      [stamp, people.length, byUser]);
      if (renamed.changes) console.log(`AD refresh: ${renamed.changes} asset(s) now show a name corrected in AD`);
    } catch (e) {
      console.error('AD refresh failed:', e.message);
      await run(`INSERT INTO ad_sync (id, at, error) VALUES (1, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET error = excluded.error`, [new Date().toISOString(), e.message]).catch(() => {});
    } finally {
      refreshing = false;
      done();
    }
  }

  /* ---------------------------- Resolve a holder ---------------------------- */
  // Exact matches only, the same rules as level 1 of the 2026-11-12 audit: an AD login
  // (with or without DOMAIN\ or @domain), the full AD name of exactly one account, or the
  // name of a place. Anything else is 'text' when allowText, else refused.
  async function matchText(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const byLogin = await get(`SELECT login, name FROM ad_people WHERE login = ?`, [bareLogin(t)]);
    if (byLogin) return { kind: PERSON, key: byLogin.login, name: byLogin.name };
    const sq = squash(t);
    if (sq) {
      const named = (await all(`SELECT login, name FROM ad_people`)).filter((p) => squash(p.name) === sq);
      if (named.length === 1) return { kind: PERSON, key: named[0].login, name: named[0].name };
      const place = (await all(`SELECT id, name FROM places WHERE archived = 0`)).filter((p) => squash(p.name) === sq);
      if (place.length === 1) return { kind: PLACE, key: String(place[0].id), name: place[0].name };
    }
    return null;
  }

  // Sets asset.assignedTo / assigneeKind / assigneeKey from what was sent.
  //   kind 'person' + key → that AD login (refused if FAS does not know it)
  //   kind 'place'  + key → that place id
  //   kind 'text'         → kept only if it is the asset's current text (no new free text);
  //                         previous: the row before this save, or null
  //   no kind, assignedTo → matched exactly, or kept as 'text' (imports, the scanner)
  //   neither sent        → left as it is
  async function applyAssignee(asset, { previous = null } = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(asset, k);
    if (!has('assigneeKind') && !has('assignedTo') && !has('assigneeKey')) return asset;
    const kind = asset.assigneeKind || null;
    const key = asset.assigneeKey == null ? '' : String(asset.assigneeKey).trim();
    const set = (k, kk, name) => Object.assign(asset, { assigneeKind: k, assigneeKey: kk, assignedTo: name });

    if (kind === PERSON) {
      const p = await get(`SELECT login, name FROM ad_people WHERE login = ?`, [key]);
      if (!p) throw new HttpError(400, `"${key}" is not an Active Directory account FAS knows. Sign in again to refresh the list.`);
      return set(PERSON, p.login, p.name);
    }
    if (kind === PLACE) {
      const pl = await get(`SELECT id, name FROM places WHERE id = ?`, [key]);
      if (!pl) throw new HttpError(400, 'That place is not in the list.');
      return set(PLACE, String(pl.id), pl.name);
    }
    if (kind === TEXT) {
      const text = String(asset.assignedTo || '').trim();
      if (previous && previous.assigneeKind === TEXT && text === String(previous.assignedTo || '').trim()) {
        return set(TEXT, null, previous.assignedTo);
      }
      const m = await matchText(text);
      if (m) return set(m.kind, m.key, m.name);
      throw new HttpError(400, 'Pick the person from Active Directory or a place from the list.');
    }
    if (kind) throw new HttpError(400, `Unknown holder kind "${kind}".`);

    const text = String(asset.assignedTo || '').trim();
    if (!text) return set(null, null, '');
    const m = await matchText(text);
    if (m) return set(m.kind, m.key, m.name);
    return set(TEXT, null, text);
  }

  /* ----------------------------- Holder history ----------------------------- */
  const norm = (v) => (v == null ? '' : String(v).trim());
  function sameHolder(a, b) {
    const ka = a?.assigneeKind || null, kb = b?.assigneeKind || null;
    if (ka !== kb) return false;
    if (ka === PERSON || ka === PLACE) return norm(a.assigneeKey).toLowerCase() === norm(b.assigneeKey).toLowerCase();
    return norm(a?.assignedTo) === norm(b?.assignedTo);
  }

  // before: the row as it was (null for a new asset); after: the saved asset. Never throws:
  // the asset is already saved, and a lost history row must not turn the save into an error.
  function recordChange(assetId, before, after, { by = null, source = null } = {}) {
    if (!after || (!('assigneeKind' in after) && !('assignedTo' in after))) return Promise.resolve();
    if (sameHolder(before, after)) return Promise.resolve();
    return run(`INSERT INTO holder_changes (assetId, byUser, source, fromKind, fromKey, fromName, toKind, toKey, toName)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [assetId, by, source,
      before?.assigneeKind || null, before?.assigneeKey || null, norm(before?.assignedTo) || null,
      after.assigneeKind || null, after.assigneeKey || null, norm(after.assignedTo) || null])
      .catch((e) => console.error('Holder history not saved:', e.message));
  }

  /* ------------------------------ Holder check ------------------------------ */
  // Values that are not a serial number; several assets share them, so they identify nothing.
  const NOT_SERIAL = new Set(['', 'na', 'notapplicable', 'unknown', 'none', 'tobefilledbyoem', 'defaultstring', 'systemserialnumber', '0']);
  const serialKey = (s) => { const k = squash(s); return NOT_SERIAL.has(k) || k.length < 4 ? '' : k; };
  const macKey = (m) => { const h = String(m || '').toUpperCase().replace(/[^0-9A-F]/g, ''); return h.length === 12 ? h : ''; };
  const ADMINISH = /^(admin|administrator)|admin$|^os-admin$/i;

  // devices: [{ serialNumber, macAddress, hostName, user }] from ManageEngine or the scanner.
  // Finds each device's asset (serial number first, then MAC, then host name, each only when
  // exactly one asset has it), ties the device's logged-on user to an AD person by the exact
  // rules, and lists the assets whose holder in FAS is someone else. It changes nothing.
  async function checkHolders(devices) {
    const assets = await all(`SELECT assetId, assetType, "group", brandModel, serialNumber, macAddress, hostName,
                                     assignedTo, assigneeKind, assigneeKey FROM assets`);
    const index = (keyFn) => {
      const m = new Map();
      for (const a of assets) { const k = keyFn(a); if (k) m.set(k, m.has(k) ? null : a); } // null = shared, unusable
      return m;
    };
    const bySerial = index((a) => serialKey(a.serialNumber));
    const byMac = index((a) => macKey(a.macAddress));
    const byHost = index((a) => norm(a.hostName).toLowerCase());
    const out = { checked: 0, matched: 0, same: 0, noUser: 0, userNotInAd: [], unmatched: [], differences: [] };
    const seen = new Set();
    for (const d of devices || []) {
      out.checked++;
      let asset = null, matchedBy = null;
      const s = serialKey(d.serialNumber), m = macKey(d.macAddress), h = norm(d.hostName).toLowerCase();
      if (s && bySerial.get(s)) { asset = bySerial.get(s); matchedBy = 'serial number'; }
      else if (m && byMac.get(m)) { asset = byMac.get(m); matchedBy = 'MAC address'; }
      else if (h && byHost.get(h)) { asset = byHost.get(h); matchedBy = 'host name'; }
      if (!asset) { out.unmatched.push({ hostName: d.hostName || '', serialNumber: d.serialNumber || '' }); continue; }
      if (seen.has(asset.assetId)) continue;
      seen.add(asset.assetId);
      out.matched++;
      const raw = norm(d.user);
      if (!raw) { out.noUser++; continue; }
      const who = await matchText(raw);
      if (!who || who.kind !== PERSON) { out.userNotInAd.push({ assetId: asset.assetId, user: raw }); continue; }
      if (asset.assigneeKind === PERSON && norm(asset.assigneeKey).toLowerCase() === who.key.toLowerCase()) { out.same++; continue; }
      const p = await get(`SELECT login, name, department, disabled, inAd FROM ad_people WHERE login = ?`, [who.key]);
      out.differences.push({
        assetId: asset.assetId, assetType: asset.assetType, brandModel: asset.brandModel, hostName: asset.hostName,
        matchedBy,
        current: { kind: asset.assigneeKind || null, key: asset.assigneeKey || null, name: asset.assignedTo || '' },
        device: { login: p.login, name: p.name, department: p.department, disabled: !!p.disabled, adminAccount: ADMINISH.test(p.login) },
        rawUser: raw,
      });
    }
    return out;
  }

  /* -------------------------------- Routes -------------------------------- */
  function registerRoutes(app) {
    const h = (fn) => async (req, res) => {
      try { await fn(req, res); } catch (e) {
        if (!e.status) console.error('People error:', e);
        if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
      }
    };

    // Everyone an asset can be given to: AD people and places, with how many assets each holds.
    app.get('/people', h(async (req, res) => {
      const [people, places, sync] = await Promise.all([
        all(`SELECT p.login, p.name, p.email, p.department, p.title, p.disabled, p.inAd,
                    (SELECT COUNT(*) FROM assets a WHERE a.assigneeKind = 'person' AND a.assigneeKey = p.login COLLATE NOCASE) AS assets
             FROM ad_people p ORDER BY p.name COLLATE NOCASE`),
        all(`SELECT pl.id, pl.name, pl.archived,
                    (SELECT COUNT(*) FROM assets a WHERE a.assigneeKind = 'place' AND a.assigneeKey = CAST(pl.id AS TEXT)) AS assets
             FROM places pl ORDER BY pl.name COLLATE NOCASE`),
        get(`SELECT at, count, byUser, error FROM ad_sync WHERE id = 1`),
      ]);
      res.json({ people, places, sync: sync || null });
    }));

    // Add a place. Refused when one with the same letters already exists ("Floor 7" / "floor7").
    app.post('/places', h(async (req, res) => {
      const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim();
      if (!name) throw new HttpError(400, 'Name required');
      const same = (await all(`SELECT id, name, archived FROM places`)).find((p) => squash(p.name) === squash(name));
      if (same) throw new HttpError(409, `"${same.name}" is already in the list${same.archived ? ' (archived)' : ''}.`);
      const r = await run(`INSERT INTO places (name, createdBy) VALUES (?, ?)`, [name, req.session?.user?.email || null]);
      logAudit(req, 'place.created', 'place', r.lastID, { name });
      res.status(201).json({ id: r.lastID, name });
    }));

    // Rename (every asset there shows the new name) or archive a place.
    app.put('/places/:id', h(async (req, res) => {
      const pl = await get(`SELECT id, name FROM places WHERE id = ?`, [req.params.id]);
      if (!pl) throw new HttpError(404, 'Place not found');
      const name = req.body?.name != null ? String(req.body.name).replace(/\s+/g, ' ').trim() : pl.name;
      if (!name) throw new HttpError(400, 'Name required');
      const same = (await all(`SELECT id, name FROM places WHERE id <> ?`, [pl.id])).find((p) => squash(p.name) === squash(name));
      if (same) throw new HttpError(409, `"${same.name}" is already in the list.`);
      const archived = req.body?.archived != null ? (req.body.archived ? 1 : 0) : undefined;
      await run(`UPDATE places SET name = ?${archived !== undefined ? ', archived = ?' : ''} WHERE id = ?`,
        archived !== undefined ? [name, archived, pl.id] : [name, pl.id]);
      await run(`UPDATE assets SET assignedTo = ? WHERE assigneeKind = 'place' AND assigneeKey = ?`, [name, String(pl.id)]);
      logAudit(req, 'place.updated', 'place', pl.id, { from: pl.name, to: name, archived });
      res.json({ id: pl.id, name });
    }));

    const BRIEF = `a.assetId, a.assetType, a."group", a.brandModel, a.serialNumber, a.hostName, a.status, a.department`;

    // One person's or place's page: what they hold now (with since when, when known) and every
    // asset they were given or that was taken from them.
    app.get('/holders/:kind/:key', h(async (req, res) => {
      const { kind, key } = req.params;
      let holder;
      if (kind === PERSON) holder = await get(`SELECT login AS key, name, email, department, title, disabled, inAd FROM ad_people WHERE login = ?`, [key]);
      else if (kind === PLACE) holder = await get(`SELECT CAST(id AS TEXT) AS key, name, archived FROM places WHERE id = ?`, [key]);
      if (!holder) throw new HttpError(404, 'Not found');
      const k = holder.key;
      const [current, history] = await Promise.all([
        all(`SELECT ${BRIEF},
                    (SELECT MAX(c.at) FROM holder_changes c WHERE c.assetId = a.assetId AND c.toKind = ? AND c.toKey = ? COLLATE NOCASE) AS since
             FROM assets a WHERE a.assigneeKind = ? AND a.assigneeKey = ? COLLATE NOCASE ORDER BY a.assetId`, [kind, k, kind, k]),
        all(`SELECT c.id, c.assetId, c.at, c.byUser, c.source, c.fromKind, c.fromKey, c.fromName, c.toKind, c.toKey, c.toName,
                    a.assetType, a.brandModel, a.serialNumber
             FROM holder_changes c LEFT JOIN assets a ON a.assetId = c.assetId
             WHERE (c.toKind = ? AND c.toKey = ? COLLATE NOCASE) OR (c.fromKind = ? AND c.fromKey = ? COLLATE NOCASE)
             ORDER BY c.id DESC LIMIT 500`, [kind, k, kind, k]),
      ]);
      res.json({ kind, holder, current, history });
    }));

    // Who had one asset, newest first.
    app.get('/assets/:assetId/holders', h(async (req, res) => {
      res.json(await all(`SELECT id, at, byUser, source, fromKind, fromKey, fromName, toKind, toKey, toName
                          FROM holder_changes WHERE assetId = ? ORDER BY id DESC`, [req.params.assetId]));
    }));

    // Assets still held by people whose AD account is disabled or gone: devices to collect.
    app.get('/people/leavers', h(async (req, res) => {
      const rows = await all(`SELECT p.login, p.name, p.department, p.disabled, p.inAd, ${BRIEF}
                              FROM assets a JOIN ad_people p ON a.assigneeKind = 'person' AND p.login = a.assigneeKey COLLATE NOCASE
                              WHERE p.disabled = 1 OR p.inAd = 0
                              ORDER BY p.name COLLATE NOCASE, a.assetId`);
      const byPerson = new Map();
      for (const r of rows) {
        if (!byPerson.has(r.login)) byPerson.set(r.login, { login: r.login, name: r.name, department: r.department, disabled: !!r.disabled, inAd: !!r.inAd, assets: [] });
        byPerson.get(r.login).assets.push({ assetId: r.assetId, assetType: r.assetType, group: r.group, brandModel: r.brandModel, serialNumber: r.serialNumber, hostName: r.hostName, status: r.status });
      }
      res.json({ people: [...byPerson.values()], assets: rows.length });
    }));

    // Compare the users logged on to devices (ManageEngine, the scanner) with FAS. Changes nothing.
    app.post('/holders/check', h(async (req, res) => {
      const devices = Array.isArray(req.body?.devices) ? req.body.devices : [];
      if (!devices.length) throw new HttpError(400, 'No devices sent');
      res.json(await checkHolders(devices));
    }));

    // Change only who holds one asset (the holder check's "Use this person", quick changes).
    app.post('/assets/:assetId/holder', h(async (req, res) => {
      const { assetId } = req.params;
      const previous = await get(`SELECT assignedTo, assigneeKind, assigneeKey FROM assets WHERE assetId = ?`, [assetId]);
      if (!previous) throw new HttpError(404, 'Asset not found');
      const next = { assigneeKind: req.body?.assigneeKind ?? null, assigneeKey: req.body?.assigneeKey ?? null, assignedTo: req.body?.assignedTo ?? '' };
      await applyAssignee(next, { previous });
      await run(`UPDATE assets SET assignedTo = ?, assigneeKind = ?, assigneeKey = ? WHERE assetId = ?`,
        [next.assignedTo, next.assigneeKind, next.assigneeKey, assetId]);
      const source = ['holder-check'].includes(req.body?.source) ? req.body.source : 'quick-change';
      await recordChange(assetId, previous, next, { by: req.session?.user?.email || null, source });
      logAudit(req, 'asset.holder_changed', 'asset', assetId, { from: previous.assignedTo, to: next.assignedTo, source });
      res.json({ assetId, assignedTo: next.assignedTo, assigneeKind: next.assigneeKind, assigneeKey: next.assigneeKey });
    }));
  }

  return { refreshFromLdap, applyAssignee, recordChange, checkHolders, serialKey, registerRoutes, entryToObject, HttpError };
}

module.exports = { createPeople, squash, bareLogin, entryToObject };
