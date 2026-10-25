// src/components/ConsumableLog.jsx — the store log: every stock movement and item change
import React, { useEffect, useMemo, useState } from 'react';
import { getConsumableLog } from '../utils/api';
import { exportConsumableLogToExcel } from '../utils/exportUtils';
import { fmtDbTime } from '../utils/format';
import Modal from './Modal';

// How each log action is shown, and the sign of its quantity (null: no quantity shown).
// A stock count stores the signed difference, so its sign is already in the quantity.
export const LOG_ACTIONS = {
  add:      { label: 'ADD',      title: 'Added to stock',  bg: '#d1fae5', color: '#065f46', sign: 1 },
  subtract: { label: 'USE',      title: 'Used from stock', bg: '#fee2e2', color: '#991b1b', sign: -1 },
  adjust:   { label: 'COUNT',    title: 'Stock count',     bg: '#fef3c7', color: '#92400e', sign: 1 },
  created:  { label: 'NEW ITEM', title: 'Item added',      bg: '#dbeafe', color: '#1e40af', sign: 1 },
  updated:  { label: 'EDITED',   title: 'Item edited',     bg: '#f3f4f6', color: '#374151', sign: null },
  archived: { label: 'ARCHIVED', title: 'Item archived',   bg: '#e5e7eb', color: '#4b5563', sign: null },
  restored: { label: 'RESTORED', title: 'Item restored',   bg: '#dcfce7', color: '#166534', sign: null },
};

const PERIODS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['month', 'This month'],
  ['all', 'All time'],
];

// The start of a period, or null for all time
function periodStart(period) {
  if (period === 'all') return null;
  const d = new Date();
  if (period === 'month') d.setDate(1);
  else d.setDate(d.getDate() - Number(period));
  d.setHours(0, 0, 0, 0);
  return d;
}

// "+5", "−2", or "—" when the entry has no quantity
export function logQuantity(row) {
  const a = LOG_ACTIONS[row.action];
  if (!a || a.sign === null || row.quantity === null || row.quantity === undefined) return '—';
  const n = a.sign * row.quantity;
  if (row.action === 'created' && n === 0) return '—';
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

export default function ConsumableLog({ onClose }) {
  const [period, setPeriod] = useState('30');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null); // null while loading
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setRows(null);
    getConsumableLog({ from: periodStart(period) })
      .then((list) => { if (alive) { setRows(list || []); setError(''); } })
      .catch((err) => { if (alive) { setRows([]); setError(err.message); } });
    return () => { alive = false; };
  }, [period]);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => (rows || []).filter(r =>
    (!action || r.action === action) &&
    (!q || [r.itemId, r.itemName, r.category, r.reason, r.user].some(v => String(v ?? '').toLowerCase().includes(q)))
  ), [rows, action, q]);

  const handleExport = () => {
    if (shown.length === 0) {
      alert('No log entries to export');
      return;
    }
    exportConsumableLogToExcel(shown, LOG_ACTIONS);
  };

  return (
    <Modal isOpen onClose={onClose}>
      <div style={{ width: '100%' }}>
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>Stock Log</h3>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          Every stock movement and item change, newest first.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} aria-label="Period">
            {PERIODS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select value={action} onChange={(e) => setAction(e.target.value)} style={inputStyle} aria-label="Action">
            <option value="">All actions</option>
            {Object.entries(LOG_ACTIONS).map(([key, a]) => <option key={key} value={key}>{a.title}</option>)}
          </select>
          <input
            type="text"
            placeholder="Search item, ID, reason, user..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, flex: 1, minWidth: 180 }}
          />
          <button onClick={handleExport} style={exportBtnStyle}>Export to Excel</button>
        </div>

        {error && <div style={{ color: '#991b1b', background: '#fee2e2', padding: '8px 10px', borderRadius: 6, marginBottom: 10, fontSize: 13 }}>Couldn't load the log: {error}</div>}

        <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
          {rows === null ? 'Loading…' : `${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}`}
        </div>

        <div style={{ maxHeight: '60vh', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Item</th>
                <th style={thStyle}>Action</th>
                <th style={thStyle}>Qty</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>By</th>
              </tr>
            </thead>
            <tbody>
              {rows !== null && shown.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', fontStyle: 'italic', color: '#9ca3af' }}>No log entries for these filters.</td></tr>
              )}
              {shown.map((r, i) => {
                const a = LOG_ACTIONS[r.action] || { label: String(r.action).toUpperCase(), bg: '#f3f4f6', color: '#374151' };
                const qty = logQuantity(r);
                return (
                  <tr key={`${r.kind}-${r.time}-${r.itemId}-${i}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{fmtDbTime(r.time)}</td>
                    <td style={tdStyle}>
                      <div>{r.itemName || r.itemId}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{[r.itemId, r.category].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 500, background: a.bg, color: a.color, whiteSpace: 'nowrap' }}>
                        {a.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: qty.startsWith('−') ? '#991b1b' : qty.startsWith('+') ? '#065f46' : '#6b7280' }}>{qty}</td>
                    <td style={tdStyle}>{r.reason || '-'}</td>
                    <td style={tdStyle}>{r.user || 'system'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

// Styles
const inputStyle = {
  padding: 8,
  fontSize: 14,
  borderRadius: 5,
  border: '1px solid #ccc',
  background: '#fff'
};

const exportBtnStyle = {
  padding: '8px 16px',
  fontSize: 14,
  border: 'none',
  borderRadius: 5,
  cursor: 'pointer',
  background: '#0ea5e9',
  color: '#fff',
  fontWeight: '600'
};

const thStyle = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 600,
  color: '#374151',
  borderBottom: '1px solid #e5e7eb'
};

const tdStyle = {
  padding: '10px 12px',
  fontSize: 14,
  color: '#1f2937',
  verticalAlign: 'top'
};
