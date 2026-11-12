// PeopleView: who holds what. Every Active Directory person and place with the assets they hold
// now and held before, and, first, the people who left SWD (account disabled or removed from AD)
// but still hold assets, so those devices get collected.
import React, { useEffect, useMemo, useState } from 'react';
import { getPeople, getHolder, getLeavers } from '../utils/api';

const SOURCE = {
  form: 'edited', 'quick-change': 'changed', 'holder-check': 'holder check', import: 'import',
  scan: 'network scan', link: 'linked to AD',
};
const day = (s) => (s ? String(s).slice(0, 10) : '');
const words = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);

export default function PeopleView() {
  const [data, setData] = useState(null);
  const [leavers, setLeavers] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [onlyHolding, setOnlyHolding] = useState(true);
  const [tab, setTab] = useState('people');
  const [open, setOpen] = useState(null); // { kind, key }

  useEffect(() => {
    getPeople().then(setData).catch((e) => setError(e.message));
    getLeavers().then(setLeavers).catch(() => setLeavers({ people: [], assets: 0 }));
  }, []);

  const list = useMemo(() => {
    if (!data) return [];
    const q = words(query);
    const rows = tab === 'people'
      ? data.people.map((p) => ({ kind: 'person', key: p.login, name: p.name, sub: [p.login, p.department].filter(Boolean).join(' · '), assets: p.assets, flag: !p.inAd ? 'removed from AD' : p.disabled ? 'disabled' : '' }))
      : data.places.filter((p) => !p.archived).map((p) => ({ kind: 'place', key: String(p.id), name: p.name, sub: 'Place or group', assets: p.assets, flag: '' }));
    return rows
      .filter((r) => !onlyHolding || r.assets > 0)
      .filter((r) => q.every((w) => `${r.name} ${r.sub}`.toLowerCase().includes(w)))
      .sort((a, b) => b.assets - a.assets || a.name.localeCompare(b.name));
  }, [data, query, onlyHolding, tab]);

  if (open) return <HolderPage kind={open.kind} holderKey={open.key} onBack={() => setOpen(null)} />;

  return (
    <div style={page}>
      <h2 style={h2}>People and places</h2>
      <p style={muted}>Who holds which asset. Names come from Active Directory.</p>

      {leavers && leavers.people.length > 0 && (
        <div style={warnBox}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Left SWD but still hold assets: {leavers.people.length} {leavers.people.length === 1 ? 'person' : 'people'}, {leavers.assets} {leavers.assets === 1 ? 'asset' : 'assets'}
          </div>
          {leavers.people.map((p) => (
            <div key={p.login} style={{ padding: '4px 0' }}>
              <button type="button" style={linkBtn} onClick={() => setOpen({ kind: 'person', key: p.login })}>{p.name}</button>
              <span style={muted}> {p.login} · {p.inAd ? 'account disabled' : 'removed from AD'} · </span>
              {p.assets.map((a) => a.assetId).join(', ')}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0' }}>
        <button type="button" className="btn" style={tab === 'people' ? tabOn : undefined} onClick={() => setTab('people')}>People</button>
        <button type="button" className="btn" style={tab === 'places' ? tabOn : undefined} onClick={() => setTab('places')}>Places</button>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'people' ? 'Search name, login or department' : 'Search places'} style={input} />
        <label style={{ fontSize: 14, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={onlyHolding} onChange={(e) => setOnlyHolding(e.target.checked)} /> Only those holding assets
        </label>
      </div>

      {error && <div style={{ color: '#dc2626' }}>{error}</div>}
      {!data && !error && <div style={muted}>Loading…</div>}
      {data && (
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr><th style={th}>Name</th><th style={th}>{tab === 'people' ? 'Login · Department' : ''}</th><th style={{ ...th, textAlign: 'right' }}>Assets</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.kind + r.key} style={{ cursor: 'pointer' }} onClick={() => setOpen({ kind: r.kind, key: r.key })}>
                  <td style={td}>{r.kind === 'place' ? '📍 ' : ''}<span style={{ fontWeight: 500 }}>{r.name}</span>{r.flag && <span style={tag}>{r.flag}</span>}</td>
                  <td style={{ ...td, ...muted }}>{r.kind === 'person' ? r.sub : ''}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.assets}</td>
                </tr>
              ))}
              {!list.length && <tr><td style={{ ...td, ...muted }} colSpan={3}>Nobody matches.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HolderPage({ kind, holderKey, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { getHolder(kind, holderKey).then(setD).catch((e) => setError(e.message)); }, [kind, holderKey]);

  const change = (c) => {
    const isTo = c.toKind === kind && String(c.toKey || '').toLowerCase() === String(holderKey).toLowerCase();
    if (isTo) return c.fromName ? `Given (before: ${c.fromName})` : 'Given';
    return c.toName ? `Moved to ${c.toName}` : 'Taken back (nobody)';
  };

  return (
    <div style={page}>
      <button type="button" className="btn" onClick={onBack}>← People and places</button>
      {error && <div style={{ color: '#dc2626', marginTop: 12 }}>{error}</div>}
      {!d && !error && <div style={{ ...muted, marginTop: 12 }}>Loading…</div>}
      {d && (
        <>
          <h2 style={{ ...h2, marginTop: 14 }}>{kind === 'place' ? '📍 ' : ''}{d.holder.name}</h2>
          {kind === 'person' && (
            <p style={muted}>
              {d.holder.key}{d.holder.department ? ` · ${d.holder.department}` : ''}{d.holder.title ? ` · ${d.holder.title}` : ''}{d.holder.email ? ` · ${d.holder.email}` : ''}
              {(!d.holder.inAd || d.holder.disabled) && <span style={tag}>{d.holder.inAd ? 'account disabled' : 'removed from AD'}</span>}
            </p>
          )}

          <h3 style={h3}>Holds now ({d.current.length})</h3>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr><th style={th}>Asset</th><th style={th}>Type</th><th style={th}>Brand / model</th><th style={th}>Serial</th><th style={th}>Since</th></tr></thead>
              <tbody>
                {d.current.map((a) => (
                  <tr key={a.assetId}>
                    <td style={td}>{a.assetId}</td><td style={td}>{a.assetType}</td><td style={td}>{a.brandModel}</td>
                    <td style={td}>{a.serialNumber}</td><td style={{ ...td, ...muted }}>{day(a.since) || 'before history began'}</td>
                  </tr>
                ))}
                {!d.current.length && <tr><td style={{ ...td, ...muted }} colSpan={5}>Nothing.</td></tr>}
              </tbody>
            </table>
          </div>

          <h3 style={h3}>History</h3>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr><th style={th}>Date</th><th style={th}>Asset</th><th style={th}>What happened</th><th style={th}>By</th></tr></thead>
              <tbody>
                {d.history.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{day(c.at)}</td>
                    <td style={td}>{c.assetId}{c.assetType ? <span style={muted}> · {c.assetType}</span> : null}</td>
                    <td style={td}>{change(c)}<span style={muted}>{SOURCE[c.source] ? ` · ${SOURCE[c.source]}` : ''}</span></td>
                    <td style={{ ...td, ...muted }}>{c.byUser || ''}</td>
                  </tr>
                ))}
                {!d.history.length && <tr><td style={{ ...td, ...muted }} colSpan={4}>No changes recorded yet. History starts with this update.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const page = { padding: 20, background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb' };
const h2 = { margin: '0 0 4px', fontSize: 22 };
const h3 = { margin: '20px 0 8px', fontSize: 16 };
const muted = { color: '#6b7280', fontSize: 13 };
const input = { padding: '8px 10px', fontSize: 15, border: '1px solid #d1d5db', borderRadius: 6, minWidth: 220, flex: '1 1 220px', maxWidth: 360 };
const tabOn = { background: '#111827', color: '#fff', borderColor: '#111827' };
const tableWrap = { overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 };
const table = { width: '100%', borderCollapse: 'collapse', background: '#fff' };
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 13, fontWeight: 600, color: '#374151', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' };
const td = { padding: '9px 12px', fontSize: 14, borderTop: '1px solid #f1f5f9', verticalAlign: 'top' };
const tag = { marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', whiteSpace: 'nowrap' };
const warnBox = { margin: '12px 0', padding: '10px 14px', border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 6, fontSize: 14 };
const linkBtn = { background: 'none', border: 'none', padding: 0, color: '#2563eb', cursor: 'pointer', fontSize: 14, fontWeight: 600 };
