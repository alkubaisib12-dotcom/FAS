// src/components/AssetPicker.jsx — choose assets to link to a document: type an asset ID,
// serial number or name and pick from the matches
import React, { useEffect, useRef, useState } from 'react';
import { getAllAssets } from '../utils/api';

export default function AssetPicker({ value, onChange }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef();

  // Search the asset list a moment after typing stops
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setMatches([]); return undefined; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const result = await getAllAssets({ page: 1, pageSize: 8, search: q });
        if (alive) { setMatches(result.items || []); setOpen(true); }
      } catch {
        if (alive) setMatches([]);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  // Close the list on a click outside
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const add = (asset) => {
    if (!value.some((a) => a.assetId === asset.assetId)) {
      onChange([...value, { assetId: asset.assetId, assetType: asset.assetType, brandModel: asset.brandModel }]);
    }
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="ar-picker" ref={boxRef}>
      {value.length > 0 && (
        <div className="ar-chips" style={{ marginBottom: 6 }}>
          {value.map((a) => (
            <span key={a.assetId} className="ar-chip">
              {a.assetId}{a.assetType ? ` · ${a.assetType}` : ''}
              <button type="button" aria-label={`Unlink ${a.assetId}`} onClick={() => onChange(value.filter((x) => x.assetId !== a.assetId))}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        className="ar-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => matches.length && setOpen(true)}
        placeholder="Type an asset ID, serial number or model"
      />
      {open && query.trim().length >= 2 && (
        <div className="ar-suggest">
          {matches.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 13, color: '#6b7280' }}>No assets match.</div>
          ) : matches.map((a) => (
            <button type="button" key={a.assetId} onClick={() => add(a)}>
              <b>{a.assetId}</b> · {a.assetType || '—'}{a.brandModel ? ` · ${a.brandModel}` : ''}
              {a.serialNumber ? <span style={{ color: '#6b7280' }}> · SN {a.serialNumber}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
