// AssigneePicker: who holds the asset. A person from Active Directory or a place from FAS's list,
// never free text, so the same person cannot be saved under two spellings (people.js on the server).
//
// value: { assignedTo, assigneeKind, assigneeKey } from the asset
// onChange(next): next is the same three fields
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getPeople, createPlace } from '../utils/api';

let cache = null; // one load per page; reset after adding a place
const loadPeople = (fresh) => {
  if (!cache || fresh) cache = getPeople().catch((e) => { cache = null; throw e; });
  return cache;
};

// Every word typed must appear in the name, login, email or department, in any order:
// "ahmed alathari" lists both "Ahmed Abdulla Alathari" and "Abdulla Ahmed Alathari", and the
// person choosing sees the login and department of each before picking.
const words = (s) => String(s || '').toLowerCase().split(/[\s.\\@_-]+/).filter(Boolean);
const fits = (q, ...fields) => {
  const hay = fields.map((f) => String(f || '').toLowerCase()).join(' ');
  return words(q).every((w) => hay.includes(w));
};

// Consonants only, so English spellings of one Arabic name meet:
// Hisham/Hesham → hshm, Raed/Raid → rd, Mohamed/Mohammed → mhmd, Yusuf/Yousif → ysf.
const skeleton = (w) => w.replace(/^(al|el)(?=...)/, '').replace(/[aeiouyw]/g, '').replace(/(.)\1+/g, '$1');

// How well a person fits what was typed: a whole word beats the start of a word beats a
// spelling with the same consonants beats a piece of the login. Admin accounts go last.
function score(q, p) {
  const nameWords = words(p.name);
  let s = 0;
  for (const w of words(q)) {
    if (nameWords.includes(w)) s += 3;
    else if (nameWords.some((n) => n.startsWith(w))) s += 2;
    else if (w.length >= 3 && nameWords.some((n) => n.length >= 3 && skeleton(n) === skeleton(w))) s += 2;
    else if (String(p.login).toLowerCase().includes(w)) s += 1;
  }
  if (/^admin|admin$/i.test(p.login) || /^admin\b/i.test(p.name)) s -= 2;
  return s;
}

export default function AssigneePicker({ value, onChange, inputStyle }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  const kind = value?.assigneeKind || null;
  const key = value?.assigneeKey || '';
  const text = value?.assignedTo || '';

  useEffect(() => {
    loadPeople().then(setData).catch((e) => setError(e.message));
  }, []);

  // An old typed name: start the search with it so the likely people are listed first.
  useEffect(() => {
    if (kind === 'text' && text) setQuery(text);
  }, [kind, text]);

  useEffect(() => {
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const person = kind === 'person' && data ? data.people.find((p) => p.login.toLowerCase() === key.toLowerCase()) : null;
  const place = kind === 'place' && data ? data.places.find((p) => String(p.id) === String(key)) : null;

  const matches = useMemo(() => {
    if (!data) return { people: [], places: [] };
    const q = query.trim();
    const ppl = data.people
      .filter((p) => p.inAd)
      .filter((p) => !q || fits(q, p.name, p.login, p.email, p.department))
      .sort((a, b) => (q ? score(q, b) - score(q, a) : 0) || a.disabled - b.disabled || a.name.localeCompare(b.name));
    const plc = data.places.filter((p) => !p.archived && (!q || fits(q, p.name)));
    // Nobody has every word ("Hisham Hayat" when AD says "Hesham"): list who has any longer
    // word or the same consonants, best first, so the person is found and not saved as a
    // "place" by mistake.
    const loose = q && !ppl.length
      ? data.people
        .filter((p) => p.inAd && words(q).some((w) => w.length >= 3 && score(w, p) > 0))
        .sort((a, b) => score(q, b) - score(q, a) || a.disabled - b.disabled || a.name.localeCompare(b.name))
      : [];
    return { people: ppl.slice(0, 8), morePeople: Math.max(0, ppl.length - 8), places: plc.slice(0, 8), loose: loose.slice(0, 8) };
  }, [data, query]);

  const pickPerson = (p) => { onChange({ assigneeKind: 'person', assigneeKey: p.login, assignedTo: p.name }); setOpen(false); setQuery(''); };
  const pickPlace = (p) => { onChange({ assigneeKind: 'place', assigneeKey: String(p.id), assignedTo: p.name }); setOpen(false); setQuery(''); };
  const clear = () => { onChange({ assigneeKind: null, assigneeKey: null, assignedTo: '' }); setQuery(''); };

  const addPlace = async () => {
    const name = query.replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (!window.confirm(`Add "${name}" to the list of places?\n\nOnly for a room, floor, rack, store or group. A person must be picked from Active Directory.`)) return;
    setBusy(true);
    try {
      const created = await createPlace(name);
      const fresh = await loadPeople(true);
      setData(fresh);
      pickPlace(created);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const exactPlace = data && query.trim() &&
    data.places.some((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, '') === query.toLowerCase().replace(/[^a-z0-9]/g, ''));

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      {/* What is chosen now */}
      {kind === 'person' && (
        <div style={chip}>
          <div>
            <div style={{ fontWeight: 600 }}>{person?.name || text}</div>
            <div style={sub}>
              {key}{person?.department ? ` · ${person.department}` : ''}
              {person && (person.disabled || !person.inAd) ? <span style={warnTag}>{person.inAd ? 'account disabled' : 'removed from AD'}</span> : null}
            </div>
          </div>
          <button type="button" onClick={clear} style={linkBtn}>Clear</button>
        </div>
      )}
      {kind === 'place' && (
        <div style={chip}>
          <div>
            <div style={{ fontWeight: 600 }}>📍 {place?.name || text}</div>
            <div style={sub}>Place or group</div>
          </div>
          <button type="button" onClick={clear} style={linkBtn}>Clear</button>
        </div>
      )}
      {kind === 'text' && (
        <div style={{ ...chip, background: '#fffbeb', borderColor: '#f59e0b' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{text}</div>
            <div style={{ ...sub, color: '#92400e' }}>Typed by hand, not linked to anyone. Pick the person or place below.</div>
          </div>
        </div>
      )}

      {/* Search */}
      <input
        type="text"
        value={query}
        placeholder={kind ? 'Change: search a person or place…' : 'Search a person (name or login) or a place…'}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginTop: kind ? 6 : 0 }}
        autoComplete="off"
      />
      {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 4 }}>Could not load people: {error}</div>}
      {data && !data.people.length && (
        <div style={{ color: '#92400e', fontSize: 13, marginTop: 4 }}>
          No Active Directory people yet. Sign out and in again: FAS reads the list when IT signs in.
        </div>
      )}

      {open && data && (
        <div style={menu}>
          {matches.people.length > 0 && <div style={menuHead}>People (Active Directory)</div>}
          {matches.people.map((p) => (
            <button type="button" key={p.login} onClick={() => pickPerson(p)} style={item}>
              <span style={{ fontWeight: 500 }}>{p.name}</span>
              <span style={sub}> {p.login}{p.department ? ` · ${p.department}` : ''}</span>
              {p.disabled ? <span style={warnTag}>disabled</span> : null}
            </button>
          ))}
          {matches.morePeople > 0 && <div style={{ ...sub, padding: '4px 10px' }}>{matches.morePeople} more: type more of the name</div>}

          {matches.places.length > 0 && <div style={menuHead}>Places and groups</div>}
          {matches.places.map((p) => (
            <button type="button" key={p.id} onClick={() => pickPlace(p)} style={item}>📍 {p.name}</button>
          ))}

          {matches.loose.length > 0 && (
            <>
              <div style={menuHead}>No exact match. People with one of these words:</div>
              {matches.loose.map((p) => (
                <button type="button" key={p.login} onClick={() => pickPerson(p)} style={item}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span style={sub}> {p.login}{p.department ? ` · ${p.department}` : ''}</span>
                  {p.disabled ? <span style={warnTag}>disabled</span> : null}
                </button>
              ))}
            </>
          )}
          {!matches.people.length && !matches.loose.length && !matches.places.length && (
            <div style={{ ...sub, padding: '8px 10px' }}>Nobody matches "{query}".</div>
          )}
          {/* Only when no person is even close: a person's name must never become a place. */}
          {query.trim() && !exactPlace && !matches.people.length && !matches.loose.length && (
            <button type="button" onClick={addPlace} disabled={busy} style={{ ...item, color: '#2563eb', borderTop: '1px solid #e5e7eb' }}>
              + Add "{query.trim()}" as a new place
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const chip = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: '#f9fafb',
};
const sub = { fontSize: 13, color: '#6b7280' };
const warnTag = { marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 8, background: '#fee2e2', color: '#991b1b' };
const linkBtn = { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 14, padding: 4 };
const menu = {
  position: 'absolute', zIndex: 20, left: 0, right: 0, marginTop: 2, maxHeight: 320, overflowY: 'auto',
  background: '#fff', border: '1px solid #d1d5db', borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
};
const menuHead = { fontSize: 12, fontWeight: 600, color: '#374151', padding: '6px 10px', background: '#f3f4f6' };
const item = {
  display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none',
  cursor: 'pointer', fontSize: 15,
};
