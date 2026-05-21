// src/components/ManageEngineModal.jsx
import React, { useState, useRef } from 'react';
import Modal from './Modal';
import { API_URL, bulkAddAssets, getNextAssetId } from '../utils/api';

// ── CSV column → FAS field mapping ───────────────────────────────────────────
const FIELD_LABELS = {
  hostName:     ['computer name', 'resource name', 'host name', 'hostname', 'device name', 'name'],
  serialNumber: ['serial number', 'serial no', 'serial', 'service tag'],
  _mfr:         ['manufacturer', 'brand', 'make', 'vendor'],
  brandModel:   ['model', 'brand model', 'product', 'device model'],
  assignedTo:   ['last logged in user', 'last user', 'assigned to', 'primary user', 'user name', 'current user', 'logged in user'],
  department:   ['department', 'dept', 'ou', 'organizational unit'],
  ipAddress:    ['ip address', 'ip', 'ipv4 address', 'ip addr'],
  macAddress:   ['mac address', 'mac', 'physical address', 'mac addr'],
  osFirmware:   ['os', 'operating system', 'os name', 'os version'],
  cpu:          ['cpu', 'processor', 'processor name', 'processor type'],
  ram:          ['ram', 'memory', 'total memory', 'total ram', 'ram (mb)', 'ram(mb)', 'ram size'],
  storage:      ['hdd', 'hard disk', 'disk', 'storage', 'total hdd', 'total disk size', 'hdd (gb)', 'hdd(gb)', 'disk size'],
};

function autoMapColumns(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  const map = {};
  for (const [field, labels] of Object.entries(FIELD_LABELS)) {
    for (const label of labels) {
      const idx = lower.findIndex(h => h.includes(label));
      if (idx !== -1 && !(field in map)) { map[field] = idx; break; }
    }
  }
  return map;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseRow = (line) => {
    const cells = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cells.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.replace(/^"|"$/g, '').trim());
    return cells;
  };

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map(parseRow);
  return { headers, rows };
}

function rowToAsset(row, colMap) {
  const get = f => (colMap[f] !== undefined ? (row[colMap[f]] || '') : '').trim();
  let brandModel = get('brandModel');
  const mfr = get('_mfr');
  if (mfr && brandModel && !brandModel.toLowerCase().startsWith(mfr.toLowerCase())) {
    brandModel = `${mfr} ${brandModel}`.trim();
  } else if (mfr && !brandModel) {
    brandModel = mfr;
  }
  return {
    hostName:     get('hostName'),
    serialNumber: get('serialNumber'),
    brandModel,
    assignedTo:   get('assignedTo'),
    department:   get('department'),
    ipAddress:    get('ipAddress'),
    macAddress:   get('macAddress'),
    osFirmware:   get('osFirmware'),
    cpu:          get('cpu'),
    ram:          get('ram'),
    storage:      get('storage'),
    status:       'Active',
  };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ManageEngineModal({ isOpen, onClose, onImported }) {
  const [tab, setTab] = useState('csv');

  // CSV state
  const [csvDevices, setCsvDevices] = useState([]);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [colMap, setColMap] = useState({});
  const fileRef = useRef();

  // API state
  const [meUrl, setMeUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiDevices, setApiDevices] = useState([]);
  const [fetching, setFetching] = useState(false);

  // Shared
  const [selected, setSelected] = useState({});
  const [assetType, setAssetType] = useState('Desktop / Laptop');
  const [group, setGroup] = useState('Windows');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const devices = tab === 'csv' ? csvDevices : apiDevices;
  const selectedCount = devices.filter((_, i) => selected[i]).length;

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { headers, rows } = parseCSV(ev.target.result);
      if (!headers.length) { setError('Could not parse CSV — check the file format.'); return; }
      const map = autoMapColumns(headers);
      setCsvHeaders(headers);
      setColMap(map);
      const parsed = rows
        .map(r => rowToAsset(r, map))
        .filter(a => a.hostName || a.serialNumber || a.ipAddress);
      setCsvDevices(parsed);
      setSelected(Object.fromEntries(parsed.map((_, i) => [i, true])));
      setError('');
      setResult(null);
    };
    reader.readAsText(file);
  };

  const handleApiFetch = async () => {
    if (!meUrl.trim()) { setError('Enter the ManageEngine server URL.'); return; }
    if (!apiKey.trim()) { setError('Enter an API key.'); return; }
    setFetching(true); setError(''); setResult(null);
    try {
      const res = await fetch(`${API_URL}/manageengine/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: meUrl.trim(), apiKey: apiKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const devs = Array.isArray(data.devices) ? data.devices : [];
      if (devs.length === 0) { setError('No devices returned from ManageEngine.'); return; }
      setApiDevices(devs);
      setSelected(Object.fromEntries(devs.map((_, i) => [i, true])));
    } catch (e) {
      setError(e.message);
    } finally {
      setFetching(false);
    }
  };

  const handleImport = async () => {
    const toImport = devices.filter((_, i) => selected[i]);
    if (toImport.length === 0) { setError('Select at least one device.'); return; }
    setImporting(true); setError('');
    try {
      // Generate IDs sequentially — each call reserves the ID
      const withIds = [];
      for (const d of toImport) {
        const id = await getNextAssetId(assetType);
        withIds.push({ ...d, assetId: id, group, assetType, status: d.status || 'Active' });
      }
      const res = await bulkAddAssets(withIds);
      setResult(res);
      onImported?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setCsvDevices([]); setApiDevices([]);
    setCsvHeaders([]); setColMap({});
    setSelected({}); setError(''); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  if (!isOpen) return null;

  const mappedFields = Object.keys(colMap).filter(k => !k.startsWith('_'));

  return (
    <Modal isOpen={isOpen} onClose={() => { reset(); onClose(); }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>Import from ManageEngine</h3>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        Pull PC / laptop records from Endpoint Central into FAS.
      </p>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
        {[
          { key: 'csv', label: '📄 CSV Upload' },
          { key: 'api', label: '🔌 API Connect' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setTab(key); setError(''); setResult(null); }}
            style={{
              padding: '8px 20px', border: 'none', cursor: 'pointer', fontSize: 13,
              fontWeight: tab === key ? 700 : 400,
              background: tab === key ? '#2563eb' : 'transparent',
              color: tab === key ? '#fff' : '#374151',
              borderRadius: '6px 6px 0 0',
              transition: 'background 0.15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── CSV tab ── */}
      {tab === 'csv' && (
        <div>
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#0369a1' }}>
            <strong>How to export:</strong> ManageEngine → Reports → Inventory Reports → Hardware Summary → Export as CSV
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            onChange={handleFileChange}
            style={{ fontSize: 13 }}
          />
          {csvHeaders.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
              <span style={{ color: '#374151', fontWeight: 600 }}>{csvHeaders.length} columns detected.</span>
              {' '}Mapped:{' '}
              {mappedFields.length > 0
                ? mappedFields.map(k => (
                    <span key={k} style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 4, padding: '1px 6px', marginRight: 4, display: 'inline-block' }}>{k}</span>
                  ))
                : <span style={{ color: '#dc2626' }}>No columns matched — check your CSV headers.</span>
              }
            </div>
          )}
        </div>
      )}

      {/* ── API tab ── */}
      {tab === 'api' && (
        <div>
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#0369a1' }}>
            <strong>How to get an API key:</strong> ManageEngine → Admin → API Explorer → Generate Key
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
            <input
              value={meUrl}
              onChange={e => setMeUrl(e.target.value)}
              placeholder="http://192.168.20.x:8020"
              style={inputStyle}
            />
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="API Key from ManageEngine"
              type="password"
              style={inputStyle}
            />
            <button onClick={handleApiFetch} disabled={fetching} style={btnBlue}>
              {fetching ? 'Fetching devices…' : 'Fetch All Devices'}
            </button>
          </div>
        </div>
      )}

      {/* ── Group / Type + Select All ── */}
      {devices.length > 0 && (
        <div style={{ display: 'flex', gap: 14, marginTop: 16, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, color: '#374151' }}>Group:</span>
            <select value={group} onChange={e => setGroup(e.target.value)} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
              {['Windows', 'Mobile Device', 'Servers & Infra', 'Display Devices', 'Data Center'].map(g => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, color: '#374151' }}>Asset Type:</span>
            <select value={assetType} onChange={e => setAssetType(e.target.value)} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
              {['Desktop / Laptop', 'Laptop', 'Server', 'Monitor', 'Tablets'].map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={devices.length > 0 && selectedCount === devices.length}
              onChange={e => setSelected(Object.fromEntries(devices.map((_, i) => [i, e.target.checked])))}
            />
            <span>Select all ({selectedCount} / {devices.length})</span>
          </label>
        </div>
      )}

      {/* ── Device preview table ── */}
      {devices.length > 0 && (
        <div style={{ marginTop: 12, maxHeight: 280, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={thStyle}></th>
                <th style={thStyle}>Hostname</th>
                <th style={thStyle}>Serial</th>
                <th style={thStyle}>Brand / Model</th>
                <th style={thStyle}>Assigned To</th>
                <th style={thStyle}>Department</th>
                <th style={thStyle}>IP Address</th>
                <th style={thStyle}>OS</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer' }}
                  onClick={() => setSelected(s => ({ ...s, [i]: !s[i] }))}>
                  <td style={tdStyle} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={!!selected[i]}
                      onChange={e => setSelected(s => ({ ...s, [i]: e.target.checked }))} />
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{d.hostName || '—'}</td>
                  <td style={tdStyle}>{d.serialNumber || '—'}</td>
                  <td style={tdStyle}>{d.brandModel || '—'}</td>
                  <td style={tdStyle}>{d.assignedTo || '—'}</td>
                  <td style={tdStyle}>{d.department || '—'}</td>
                  <td style={tdStyle}>{d.ipAddress || '—'}</td>
                  <td style={{ ...tdStyle, color: '#6b7280' }}>{d.osFirmware ? d.osFirmware.slice(0, 20) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div style={{ color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', marginTop: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, padding: '8px 12px', marginTop: 12, fontSize: 13 }}>
          ✓ Imported {result.inserted} device(s){result.skipped > 0 ? ` — ${result.skipped} skipped (already exist)` : ''}.
        </div>
      )}

      {/* ── Action buttons ── */}
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {devices.length > 0 && (
          <button
            onClick={handleImport}
            disabled={importing || selectedCount === 0}
            style={{ ...btnGreen, opacity: (importing || selectedCount === 0) ? 0.6 : 1 }}
          >
            {importing ? 'Importing…' : `Import ${selectedCount} Device${selectedCount !== 1 ? 's' : ''}`}
          </button>
        )}
        {(devices.length > 0 || error) && (
          <button onClick={reset} style={btnGray}>Reset</button>
        )}
      </div>
    </Modal>
  );
}

const inputStyle = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 13, width: '100%', outline: 'none',
};
const btnBlue  = { background: '#2563eb', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
const btnGreen = { background: '#16a34a', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
const btnGray  = { background: '#6b7280', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
const thStyle  = { padding: '7px 10px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const tdStyle  = { padding: '5px 10px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' };
