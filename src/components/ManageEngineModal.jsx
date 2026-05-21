// src/components/ManageEngineModal.jsx
import React, { useState, useRef } from 'react';
import Modal from './Modal';
import { API_URL, bulkAddAssets, getNextAssetId, checkSerials } from '../utils/api';

// ── CSV parser ────────────────────────────────────────────────────────────────
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
  return { headers: parseRow(lines[0]), rows: lines.slice(1).map(parseRow) };
}

// ── Detect ManageEngine full export (has both Service Tag + Monitor Serial cols) ──
function isManageEngineFullExport(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  return lower.includes('service tag') && lower.includes('monitor serial number');
}

// ── ManageEngine-specific paired parsing ──────────────────────────────────────
const ME_COL_LABELS = {
  monType:     'monitor type',
  monSerial:   'monitor serial number',
  monSize:     'monitor size',
  computer:    'computer name',
  ip:          'computer ip',
  model:       'device model',
  mfr:         'computer manufacturer',
  serviceTag:  'service tag',
  compType:    'computer type',
  storage:     'computer storage (gb)',
  logonUser:   'last logon user',
  currUser:    'currently logged on users',
  customGroup: 'custom group name',
  mac:         'computer mac',
  ouLocation:  'ou location',
  warExpiry:   'warranty expiry date',
  purchDate:   'shipping date',
};

const SKIP_MON_TYPES = new Set([
  '', 'default monitor', 'hyperv', 'hyperv monitor', 'hyperv video',
  'digital flat panel (640x480 60hz)', 'generic pnp monitor',
  'generic non-pnp monitor', 'pc monitor',
]);

function buildColIndex(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  const idx = {};
  for (const [field, label] of Object.entries(ME_COL_LABELS)) {
    const i = lower.findIndex(h => h === label);
    if (i !== -1) idx[field] = i;
  }
  return idx;
}

function parseManageEnginePairs(headers, rows) {
  const C = buildColIndex(headers);
  const g = (row, field) => C[field] !== undefined ? (row[C[field]] || '').trim() : '';

  const pcMap = new Map(); // computerName → best entry

  for (const row of rows) {
    const computer = g(row, 'computer');
    if (!computer) continue;

    const monType   = g(row, 'monType');
    const monSerial = g(row, 'monSerial');
    const hasRealMon = !SKIP_MON_TYPES.has(monType.toLowerCase()) && !!monSerial;

    const entry = {
      computer,
      serviceTag:   g(row, 'serviceTag'),
      deviceModel:  g(row, 'model'),
      mfr:          g(row, 'mfr'),
      compType:     g(row, 'compType'),
      ip:           g(row, 'ip').split(',')[0].trim(),
      mac:          g(row, 'mac').split(',')[0].trim(),
      logonUser:    g(row, 'logonUser') || g(row, 'currUser'),
      department:   g(row, 'customGroup'),
      storage:      g(row, 'storage'),
      ouLocation:   g(row, 'ouLocation'),
      warExpiry:    g(row, 'warExpiry'),
      purchDate:    g(row, 'purchDate'),
      monType,
      monSerial,
      monSize:      g(row, 'monSize'),
      hasRealMon,
    };

    const ex = pcMap.get(computer);
    if (!ex) {
      pcMap.set(computer, entry);
    } else {
      // Keep row that adds monitor data; merge department if missing
      if (!ex.hasRealMon && hasRealMon) {
        pcMap.set(computer, entry);
      } else if (!ex.department && entry.department) {
        pcMap.set(computer, { ...ex, department: entry.department });
      }
    }
  }

  return Array.from(pcMap.values()).map(e => {
    const ct = e.compType.toUpperCase();
    const isServer = ct.includes('RACK_MOUNT') || ct.includes('MAIN_SYSTEM') || ct.includes('VIRTUAL');
    const isLaptop = ct.includes('NOTEBOOK');
    const mfr = e.mfr.replace(/Inc\.?/g, '').replace(/Corporation/g, '').trim();
    const brandModel = [mfr, e.deviceModel].filter(Boolean).join(' ').trim();
    const os = e.ouLocation.toLowerCase().includes('windows xp') ? 'Windows XP' : '';

    return {
      pc: {
        group:        isServer ? 'Servers & Infra' : 'Windows',
        assetType:    isServer ? 'Server' : (isLaptop ? 'Laptop' : 'Desktop / Laptop'),
        hostName:     e.computer,
        serialNumber: e.serviceTag,
        brandModel,
        assignedTo:   e.logonUser,
        department:   e.department,
        ipAddress:    e.ip,
        macAddress:   e.mac,
        osFirmware:   os,
        storage:      e.storage ? `${e.storage} GB` : '',
        warrantyExpiry: e.warExpiry,
        purchaseDate: e.purchDate,
        status:       'Active',
      },
      monitor: e.hasRealMon ? {
        group:        'Display Devices',
        assetType:    'Monitor',
        brandModel:   e.monType,
        serialNumber: e.monSerial,
        assignedTo:   e.logonUser,
        department:   e.department,
        remarks:      e.monSize ? `${parseFloat(e.monSize).toFixed(0)}" screen` : '',
        status:       'Active',
      } : null,
    };
  });
}

// ── Generic CSV mapping (non-ME exports) ──────────────────────────────────────
const GENERIC_FIELD_LABELS = {
  hostName:     ['computer name', 'resource name', 'host name', 'hostname', 'device name'],
  serialNumber: ['serial number', 'serial no', 'serial', 'service tag'],
  _mfr:         ['manufacturer', 'brand', 'make', 'vendor'],
  brandModel:   ['model', 'brand model', 'product', 'device model'],
  assignedTo:   ['last logged in user', 'last user', 'assigned to', 'primary user', 'last logon user'],
  department:   ['department', 'dept', 'ou', 'custom group'],
  ipAddress:    ['ip address', 'ip', 'computer ip'],
  macAddress:   ['mac address', 'mac', 'computer mac'],
  osFirmware:   ['os', 'operating system', 'os name', 'os version'],
  cpu:          ['cpu', 'processor', 'processor name'],
  ram:          ['ram', 'memory', 'total memory'],
  storage:      ['hdd', 'hard disk', 'disk', 'storage', 'computer storage'],
};

function autoMapColumns(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  const map = {};
  for (const [field, labels] of Object.entries(GENERIC_FIELD_LABELS)) {
    for (const label of labels) {
      const idx = lower.findIndex(h => h.includes(label));
      if (idx !== -1 && !(field in map)) { map[field] = idx; break; }
    }
  }
  return map;
}

function rowToAsset(row, colMap) {
  const get = f => (colMap[f] !== undefined ? (row[colMap[f]] || '') : '').trim();
  let brandModel = get('brandModel');
  const mfr = get('_mfr');
  if (mfr && !brandModel.toLowerCase().startsWith(mfr.toLowerCase())) {
    brandModel = `${mfr}${brandModel ? ' ' + brandModel : ''}`.trim();
  }
  return { hostName: get('hostName'), serialNumber: get('serialNumber'), brandModel,
           assignedTo: get('assignedTo'), department: get('department'),
           ipAddress: get('ipAddress'), macAddress: get('macAddress'),
           osFirmware: get('osFirmware'), cpu: get('cpu'), ram: get('ram'),
           storage: get('storage'), status: 'Active' };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ManageEngineModal({ isOpen, onClose, onImported }) {
  const [tab, setTab] = useState('csv');

  // CSV state
  const [csvMode, setCsvMode] = useState('generic'); // 'generic' | 'me-paired'
  const [genericDevices, setGenericDevices] = useState([]);
  const [colMap, setColMap] = useState({});
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [mePairs, setMePairs] = useState([]); // for me-paired mode

  const fileRef = useRef();

  // API state
  const [meUrl, setMeUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiDevices, setApiDevices] = useState([]);
  const [fetching, setFetching] = useState(false);

  // Duplicate tracking  { serialNumber: { assetId, hostName, assignedTo, assetType } }
  const [existingMap, setExistingMap] = useState({});
  const [checking, setChecking] = useState(false);

  // Shared
  const [selected, setSelected] = useState({});
  const [createMonitors, setCreateMonitors] = useState(true);
  const [assetType, setAssetType] = useState('Desktop / Laptop');
  const [group, setGroup] = useState('Windows');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const devices = tab === 'api' ? apiDevices : genericDevices;
  const selectedCount = tab === 'csv' && csvMode === 'me-paired'
    ? mePairs.filter((_, i) => selected[i]).length
    : devices.filter((_, i) => selected[i]).length;

  // ── Check which serials are already in the DB ──
  const runSerialCheck = async (pairs, genericDevs) => {
    setChecking(true);
    try {
      const serials = [];
      if (pairs.length) {
        pairs.forEach(p => {
          if (p.pc.serialNumber)      serials.push(p.pc.serialNumber);
          if (p.monitor?.serialNumber) serials.push(p.monitor.serialNumber);
        });
      } else {
        genericDevs.forEach(d => { if (d.serialNumber) serials.push(d.serialNumber); });
      }
      if (serials.length) {
        const { existing } = await checkSerials(serials);
        setExistingMap(existing || {});
      } else {
        setExistingMap({});
      }
    } catch {
      setExistingMap({}); // non-fatal: just skip the check
    } finally {
      setChecking(false);
    }
  };

  // ── File upload ──
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { headers, rows } = parseCSV(ev.target.result);
      if (!headers.length) { setError('Could not parse CSV.'); return; }
      setError(''); setResult(null); setExistingMap({});

      if (isManageEngineFullExport(headers)) {
        const pairs = parseManageEnginePairs(headers, rows);
        setCsvMode('me-paired');
        setMePairs(pairs);
        setSelected(Object.fromEntries(pairs.map((_, i) => [i, true])));
        runSerialCheck(pairs, []);
      } else {
        const map = autoMapColumns(headers);
        setCsvHeaders(headers);
        setColMap(map);
        const parsed = rows.map(r => rowToAsset(r, map))
                           .filter(a => a.hostName || a.serialNumber || a.ipAddress);
        setCsvMode('generic');
        setGenericDevices(parsed);
        setSelected(Object.fromEntries(parsed.map((_, i) => [i, true])));
        runSerialCheck([], parsed);
      }
    };
    reader.readAsText(file);
  };

  // ── API fetch ──
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
      if (!devs.length) { setError('No devices returned from ManageEngine.'); return; }
      setApiDevices(devs);
      setSelected(Object.fromEntries(devs.map((_, i) => [i, true])));
      runSerialCheck([], devs);
    } catch (e) {
      setError(e.message);
    } finally {
      setFetching(false);
    }
  };

  // ── Import: ManageEngine paired mode ──
  const handleImportPaired = async () => {
    const toImport = mePairs.filter((_, i) => selected[i]);
    if (!toImport.length) { setError('Select at least one computer.'); return; }

    // Filter out assets whose serial already exists in the DB
    const needPC  = toImport.filter(p => !existingMap[p.pc.serialNumber]);
    const needMon = createMonitors
      ? toImport.filter(p => p.monitor && !existingMap[p.monitor.serialNumber])
      : [];

    const skippedPCs  = toImport.length - needPC.length;
    const skippedMons = createMonitors
      ? toImport.filter(p => p.monitor && existingMap[p.monitor.serialNumber]).length
      : 0;

    if (needPC.length === 0 && needMon.length === 0) {
      setError(`All ${toImport.length} selected assets already exist in the database — nothing to import.`);
      return;
    }

    setImporting(true); setError('');
    const total = needPC.length + needMon.length;
    setImportProgress(`Generating ${total} asset IDs…`);

    try {
      const pcIdPromises  = needPC.map(p  => getNextAssetId(p.pc.assetType));
      const monIdPromises = needMon.map(() => getNextAssetId('Monitor'));

      const [pcIds, monIds] = await Promise.all([
        Promise.all(pcIdPromises),
        Promise.all(monIdPromises),
      ]);

      setImportProgress(`Inserting ${total} assets…`);
      const allAssets = [];
      needPC.forEach((pair, i)  => allAssets.push({ ...pair.pc,      assetId: pcIds[i] }));
      needMon.forEach((pair, i) => allAssets.push({ ...pair.monitor, assetId: monIds[i] }));

      const res = await bulkAddAssets(allAssets);
      setResult({
        ...res,
        pcCount:      needPC.length,
        monCount:     needMon.length,
        skippedPCs,
        skippedMons,
      });
      onImported?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
      setImportProgress('');
    }
  };

  // ── Import: generic mode ──
  const handleImportGeneric = async () => {
    const toImport = devices.filter((_, i) => selected[i]);
    if (!toImport.length) { setError('Select at least one device.'); return; }
    setImporting(true); setError('');
    try {
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

  const handleImport = () =>
    tab === 'csv' && csvMode === 'me-paired' ? handleImportPaired() : handleImportGeneric();

  const reset = () => {
    setCsvMode('generic'); setGenericDevices([]); setMePairs([]);
    setCsvHeaders([]); setColMap({}); setApiDevices([]);
    setSelected({}); setError(''); setResult(null); setImportProgress('');
    setExistingMap({});
    if (fileRef.current) fileRef.current.value = '';
  };

  if (!isOpen) return null;

  const mePairedActive = tab === 'csv' && csvMode === 'me-paired';
  const selectedPairs  = mePairs.filter((_, i) => selected[i]);
  const newPCs     = selectedPairs.filter(p => !existingMap[p.pc.serialNumber]).length;
  const newMonitors= createMonitors ? selectedPairs.filter(p => p.monitor && !existingMap[p.monitor.serialNumber]).length : 0;
  const monitorsThatWillBeCreated = newMonitors;

  return (
    <Modal isOpen={isOpen} onClose={() => { reset(); onClose(); }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>Import from ManageEngine</h3>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        Pull PC / laptop and monitor records from Endpoint Central into FAS.
      </p>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
        {[{ key: 'csv', label: '📄 CSV Upload' }, { key: 'api', label: '🔌 API Connect' }].map(({ key, label }) => (
          <button key={key} onClick={() => { setTab(key); setError(''); setResult(null); }}
            style={{ padding: '8px 20px', border: 'none', cursor: 'pointer', fontSize: 13,
              fontWeight: tab === key ? 700 : 400,
              background: tab === key ? '#2563eb' : 'transparent',
              color: tab === key ? '#fff' : '#374151',
              borderRadius: '6px 6px 0 0' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── CSV Tab ── */}
      {tab === 'csv' && (
        <div>
          {csvMode !== 'me-paired' && (
            <div style={infoBanner}>
              <strong>How to export:</strong> ManageEngine → Reports → Inventory Reports → Hardware Summary → Export as CSV
            </div>
          )}
          <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFileChange} style={{ fontSize: 13 }} />

          {/* Generic mode: show mapped columns */}
          {csvMode === 'generic' && csvHeaders.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
              <span style={{ fontWeight: 600, color: '#374151' }}>{csvHeaders.length} columns detected.</span>
              {' '}Mapped:{' '}
              {Object.keys(colMap).filter(k => !k.startsWith('_')).map(k => (
                <span key={k} style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 4, padding: '1px 6px', marginRight: 4, display: 'inline-block' }}>{k}</span>
              ))}
            </div>
          )}

          {/* ME Paired mode: banner */}
          {mePairedActive && (() => {
            const dupPCs  = mePairs.filter(p => existingMap[p.pc.serialNumber]).length;
            const dupMons = mePairs.filter(p => p.monitor && existingMap[p.monitor.serialNumber]).length;
            const newPCs  = mePairs.length - dupPCs;
            return (
              <div style={{ ...infoBanner, background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534', marginTop: 10 }}>
                <strong>ManageEngine Full Export Detected — Paired Import Mode</strong>
                {checking && <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>Checking database…</span>}
                <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                  <span>📦 <strong>{mePairs.length}</strong> computers total</span>
                  <span>🖥 <strong>{mePairs.filter(p => p.monitor).length}</strong> with monitors</span>
                  {dupPCs > 0 && <span style={{ color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 7px' }}>⚠ <strong>{dupPCs}</strong> PC serial{dupPCs > 1 ? 's' : ''} already in DB</span>}
                  {dupMons > 0 && <span style={{ color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 7px' }}>⚠ <strong>{dupMons}</strong> monitor serial{dupMons > 1 ? 's' : ''} already in DB</span>}
                  {dupPCs === 0 && !checking && <span style={{ color: '#166534' }}>✓ No duplicates found</span>}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── API Tab ── */}
      {tab === 'api' && (
        <div>
          <div style={infoBanner}>
            <strong>How to get an API key:</strong> ManageEngine → Admin → API Explorer → Generate Key
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
            <input value={meUrl} onChange={e => setMeUrl(e.target.value)}
              placeholder="http://192.168.20.x:8020" style={inputStyle} />
            <input value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="API Key from ManageEngine" type="password" style={inputStyle} />
            <button onClick={handleApiFetch} disabled={fetching} style={btnBlue}>
              {fetching ? 'Fetching devices…' : 'Fetch All Devices'}
            </button>
          </div>
        </div>
      )}

      {/* ── Options row ── */}
      {(mePairedActive ? mePairs.length > 0 : devices.length > 0) && (
        <div style={{ display: 'flex', gap: 12, marginTop: 14, alignItems: 'center',
          flexWrap: 'wrap', padding: '10px 12px', background: '#f8fafc',
          borderRadius: 6, border: '1px solid #e5e7eb' }}>

          {mePairedActive ? (
            <>
              {/* ME Paired options */}
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={createMonitors} onChange={e => setCreateMonitors(e.target.checked)} />
                <span>Also create <strong>Monitor assets</strong></span>
                <span style={{ background: '#d1fae5', color: '#065f46', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>
                  {mePairs.filter(p => p.monitor).length} monitors
                </span>
              </label>
              <div style={{ width: 1, background: '#e5e7eb', alignSelf: 'stretch' }} />
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={mePairs.length > 0 && selectedCount === mePairs.length}
                  onChange={e => setSelected(Object.fromEntries(mePairs.map((_, i) => [i, e.target.checked])))} />
                <span>Select all ({selectedCount} / {mePairs.length})</span>
              </label>
            </>
          ) : (
            <>
              {/* Generic options */}
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>Group:</span>
                <select value={group} onChange={e => setGroup(e.target.value)}
                  style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
                  {['Windows', 'Mobile Device', 'Servers & Infra', 'Display Devices', 'Data Center'].map(g => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>Asset Type:</span>
                <select value={assetType} onChange={e => setAssetType(e.target.value)}
                  style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
                  {['Desktop / Laptop', 'Laptop', 'Server', 'Monitor', 'Tablets'].map(t => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={devices.length > 0 && selectedCount === devices.length}
                  onChange={e => setSelected(Object.fromEntries(devices.map((_, i) => [i, e.target.checked])))} />
                <span>Select all ({selectedCount} / {devices.length})</span>
              </label>
            </>
          )}
        </div>
      )}

      {/* ── Preview: ME Paired ── */}
      {mePairedActive && mePairs.length > 0 && (
        <div style={{ marginTop: 12, maxHeight: 340, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f1f5f9', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={thStyle}></th>
                <th style={thStyle}>Computer</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Service Tag</th>
                <th style={thStyle}>Brand / Model</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Department</th>
                <th style={{ ...thStyle, background: '#ecfdf5', borderLeft: '2px solid #a7f3d0' }}>Monitor</th>
                <th style={{ ...thStyle, background: '#ecfdf5' }}>Mon. Serial</th>
                <th style={{ ...thStyle, background: '#ecfdf5' }}>Size</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Assets</th>
              </tr>
            </thead>
            <tbody>
              {mePairs.map((pair, i) => {
                const pcExists  = !!existingMap[pair.pc.serialNumber];
                const monExists = !!(pair.monitor && existingMap[pair.monitor.serialNumber]);
                const rowBg = i % 2 === 0 ? '#fff' : '#f9fafb';
                return (
                  <tr key={i}
                    style={{ background: pcExists ? '#fffbeb' : rowBg, cursor: 'pointer' }}
                    onClick={() => setSelected(s => ({ ...s, [i]: !s[i] }))}>
                    <td style={tdStyle} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={!!selected[i]}
                        onChange={e => setSelected(s => ({ ...s, [i]: e.target.checked }))} />
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {pair.pc.hostName}
                      {pcExists && (
                        <div style={{ fontSize: 10, color: '#b45309', marginTop: 1 }}>
                          already in DB as {existingMap[pair.pc.serialNumber].assetId}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        background: pair.pc.assetType === 'Server' ? '#fef3c7' :
                                    pair.pc.assetType === 'Laptop'  ? '#ede9fe' : '#dbeafe',
                        color: pair.pc.assetType === 'Server' ? '#92400e' :
                               pair.pc.assetType === 'Laptop'  ? '#5b21b6' : '#1e40af',
                        borderRadius: 4, padding: '1px 6px', fontSize: 11
                      }}>
                        {pair.pc.assetType}
                      </span>
                    </td>
                    <td style={tdStyle}>{pair.pc.serialNumber || '—'}</td>
                    <td style={{ ...tdStyle, maxWidth: 160 }}>{pair.pc.brandModel || '—'}</td>
                    <td style={tdStyle}>{pair.pc.assignedTo || '—'}</td>
                    <td style={{ ...tdStyle, maxWidth: 140 }}>{pair.pc.department || '—'}</td>
                    {/* Monitor columns */}
                    <td style={{ ...tdStyle, borderLeft: '2px solid #a7f3d0', background: pair.monitor ? (monExists ? '#fef9c3' : '#f0fdf4') : undefined }}>
                      {pair.monitor ? (
                        <>
                          {pair.monitor.brandModel}
                          {monExists && <div style={{ fontSize: 10, color: '#b45309' }}>in DB: {existingMap[pair.monitor.serialNumber].assetId}</div>}
                        </>
                      ) : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, background: pair.monitor ? (monExists ? '#fef9c3' : '#f0fdf4') : undefined }}>
                      {pair.monitor ? pair.monitor.serialNumber : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, background: pair.monitor ? (monExists ? '#fef9c3' : '#f0fdf4') : undefined }}>
                      {pair.monitor ? pair.monitor.remarks : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      {pcExists
                        ? <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>PC exists</span>
                        : pair.monitor && createMonitors
                          ? <span style={{ background: '#d1fae5', color: '#065f46', borderRadius: 10, padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}>
                              {monExists ? 'PC new + Mon exists' : 'PC + Monitor'}
                            </span>
                          : <span style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 10, padding: '2px 8px', fontSize: 11 }}>PC only</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Preview: Generic / API ── */}
      {!mePairedActive && devices.length > 0 && (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Error / Result ── */}
      {error && (
        <div style={{ color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 6, padding: '8px 12px', marginTop: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0',
          borderRadius: 6, padding: '10px 14px', marginTop: 12, fontSize: 13 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Import complete</div>
          {result.pcCount !== undefined ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div>✓ PC assets created: <strong>{result.pcCount}</strong></div>
              {result.monCount > 0 && <div>✓ Monitor assets created: <strong>{result.monCount}</strong></div>}
              {result.skippedPCs  > 0 && <div style={{ color: '#92400e' }}>⏭ PCs skipped (already in DB): <strong>{result.skippedPCs}</strong></div>}
              {result.skippedMons > 0 && <div style={{ color: '#92400e' }}>⏭ Monitors skipped (already in DB): <strong>{result.skippedMons}</strong></div>}
            </div>
          ) : (
            <div>Total inserted: <strong>{result.inserted}</strong>
              {result.skipped > 0 ? ` — ${result.skipped} skipped (already exist)` : ''}
            </div>
          )}
        </div>
      )}

      {importProgress && (
        <div style={{ color: '#6b7280', fontSize: 13, marginTop: 10, fontStyle: 'italic' }}>
          {importProgress}
        </div>
      )}

      {/* ── Action buttons ── */}
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(mePairedActive ? mePairs.length > 0 : devices.length > 0) && (
          <button onClick={handleImport}
            disabled={importing || selectedCount === 0}
            style={{ ...btnGreen, opacity: (importing || selectedCount === 0) ? 0.6 : 1, cursor: (importing || selectedCount === 0) ? 'not-allowed' : 'pointer' }}>
            {importing ? importProgress || 'Importing…' : (
              mePairedActive
                ? newPCs === 0 && newMonitors === 0
                  ? `All ${selectedCount} already in DB`
                  : `Import ${newPCs} new PC${newPCs !== 1 ? 's' : ''}${newMonitors > 0 ? ` + ${newMonitors} Monitor${newMonitors !== 1 ? 's' : ''}` : ''}${selectedCount - newPCs > 0 ? ` (${selectedCount - newPCs} will skip)` : ''}`
                : `Import ${selectedCount} Device${selectedCount !== 1 ? 's' : ''}`
            )}
          </button>
        )}
        {(mePairs.length > 0 || devices.length > 0 || error) && (
          <button onClick={reset} style={btnGray}>Reset</button>
        )}
      </div>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const infoBanner = { background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#0369a1' };
const inputStyle = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: '100%', outline: 'none' };
const btnBlue  = { background: '#2563eb', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
const btnGreen = { background: '#16a34a', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 13 };
const btnGray  = { background: '#6b7280', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
const thStyle  = { padding: '7px 10px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const tdStyle  = { padding: '5px 10px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' };
