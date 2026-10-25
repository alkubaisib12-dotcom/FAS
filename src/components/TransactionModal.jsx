// src/components/TransactionModal.jsx
import React, { useState, useEffect } from 'react';
import { addConsumableTransaction, adjustConsumableStock, getConsumableTransactions } from '../utils/api';
import { fmtDbTime } from '../utils/format';
import Modal from './Modal';

// How each history type is shown, and the sign of its quantity
const TX_TYPES = {
  add:      { label: 'ADD',     bg: '#d1fae5', color: '#065f46', sign: 1 },
  subtract: { label: 'USE',     bg: '#fee2e2', color: '#991b1b', sign: -1 },
  adjust:   { label: 'COUNT',   bg: '#fef3c7', color: '#92400e', sign: 1 }, // quantity is stored signed
  opening:  { label: 'OPENING', bg: '#dbeafe', color: '#1e40af', sign: 1 },
};

const fmtChange = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

export default function TransactionModal({ item, onClose, onSuccess }) {
  const [activeTab, setActiveTab] = useState('transaction'); // 'transaction' | 'history'
  const [type, setType] = useState('subtract'); // 'add' | 'subtract' | 'adjust'
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (activeTab === 'history' && item) {
      loadHistory();
    }
  }, [activeTab, item]);

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const data = await getConsumableTransactions(item.id);
      setHistory(data || []);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const qtyNum = Number(quantity);
  const countDiff = type === 'adjust' && quantity !== '' && Number.isInteger(qtyNum) ? qtyNum - item.quantity : null;

  const handleSubmit = async (e) => {
    e.preventDefault();

    const qty = Number(quantity);
    if (type === 'adjust') {
      if (quantity === '' || !Number.isInteger(qty) || qty < 0) {
        alert('Please enter the counted quantity (a whole number, 0 or more)');
        return;
      }
      if (qty === item.quantity) {
        alert('The count matches the current stock, so there is nothing to change.');
        return;
      }
    } else {
      if (!Number.isInteger(qty) || qty <= 0) {
        alert('Please enter a valid quantity (a whole number above 0)');
        return;
      }
      if (type === 'subtract' && qty > item.quantity) {
        alert(`Cannot subtract ${qty}. Only ${item.quantity} available in stock.`);
        return;
      }
    }

    setLoading(true);
    try {
      const result = type === 'adjust'
        ? await adjustConsumableStock(item.id, qty, item.quantity, reason)
        : await addConsumableTransaction(item.id, type, qty, reason);
      const done = type === 'add' ? 'Quantity added' : type === 'subtract' ? 'Quantity used' : 'Stock count saved';
      alert(`Success! ${done}.\nPrevious: ${result.previousQuantity}\nNew: ${result.newQuantity}`);
      setQuantity('');
      setReason('');
    } catch (err) {
      alert('Transaction failed: ' + err.message);
    } finally {
      setLoading(false);
      // Reload either way: when it failed because someone else changed the stock meanwhile,
      // this shows the stock as it is now.
      if (onSuccess) onSuccess();
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose}>
      <div style={{ width: '100%', maxWidth: 850 }}>
        <div style={{
          background: 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)',
          padding: '14px 20px',
          borderRadius: '8px 8px 0 0',
          marginTop: -20,
          marginLeft: -20,
          marginRight: -20,
          marginBottom: 20
        }}>
          <h3 style={{ margin: 0, color: '#fff', fontSize: 18, fontWeight: 600 }}>
            {item.name}
          </h3>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 4 }}>
            ID: {item.id}
          </div>
        </div>

        <div style={{
          marginBottom: 20,
          padding: '14px 18px',
          background: '#f8fafc',
          borderRadius: 6,
          border: '1px solid #e2e8f0'
        }}>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 4 }}>
            Current Stock
          </div>
          <div style={{ fontSize: 28, fontWeight: 'bold', color: '#1e293b' }}>
            {item.quantity} <span style={{ fontSize: 14, color: '#64748b', fontWeight: 400 }}>units</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
          <button
            onClick={() => setActiveTab('transaction')}
            style={{
              ...tabBtn,
              borderBottom: activeTab === 'transaction' ? '3px solid #2563eb' : 'none',
              color: activeTab === 'transaction' ? '#2563eb' : '#6b7280'
            }}
          >
            Add / Subtract
          </button>
          <button
            onClick={() => setActiveTab('history')}
            style={{
              ...tabBtn,
              borderBottom: activeTab === 'history' ? '3px solid #2563eb' : 'none',
              color: activeTab === 'history' ? '#2563eb' : '#6b7280'
            }}
          >
            Transaction History
          </button>
        </div>

        {/* Transaction Tab */}
        {activeTab === 'transaction' && (
          <form onSubmit={handleSubmit}>
            <div style={fieldRow}>
              <label style={labelStyle}>Action *</label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {ACTIONS.map(a => (
                  <label key={a.value} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    padding: '10px 14px',
                    border: type === a.value ? `2px solid ${a.color}` : '1px solid #d1d5db',
                    borderRadius: 6,
                    flex: 1,
                    minWidth: 150,
                    background: type === a.value ? a.bg : '#fff'
                  }}>
                    <input
                      type="radio"
                      name="type"
                      value={a.value}
                      checked={type === a.value}
                      onChange={(e) => setType(e.target.value)}
                    />
                    <span style={{ color: type === a.value ? a.color : '#6b7280', fontWeight: 500, fontSize: 14 }}>
                      {a.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>{type === 'adjust' ? 'Counted quantity *' : 'Quantity *'}</label>
              <input
                type="number"
                min={type === 'adjust' ? '0' : '1'}
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                style={inputStyle}
                placeholder={type === 'adjust' ? 'How many are on the shelf?' : 'Enter quantity'}
                required
                autoFocus
              />
              {countDiff !== null && (
                <div style={{ fontSize: 13, marginTop: 6, color: countDiff === 0 ? '#6b7280' : '#92400e' }}>
                  {countDiff === 0
                    ? 'Matches the current stock.'
                    : `Stock will change from ${item.quantity} to ${qtyNum} (${fmtChange(countDiff)}).`}
                </div>
              )}
              {type === 'subtract' && quantity && parseInt(quantity) > item.quantity && (
                <div style={{
                  color: '#dc2626',
                  fontSize: 13,
                  marginTop: 6,
                  padding: '8px 10px',
                  background: '#fee2e2',
                  borderRadius: 4,
                  border: '1px solid #fca5a5'
                }}>
                  Insufficient stock! Only {item.quantity} units available.
                </div>
              )}
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Reason / Notes</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ ...inputStyle, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }}
                placeholder={
                  type === 'add' ? 'e.g., Received new shipment from vendor'
                  : type === 'subtract' ? 'e.g., Used for project XYZ, Assigned to team member'
                  : 'e.g., Monthly stock check'
                }
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                type="submit"
                disabled={loading}
                style={{
                  ...btnStyle,
                  background: ACTIONS.find(a => a.value === type).color,
                  opacity: loading ? 0.6 : 1,
                  flex: 1
                }}
              >
                {loading ? 'Processing...' : type === 'adjust' ? 'Save Stock Count' : ACTIONS.find(a => a.value === type).label}
              </button>
              <button
                type="button"
                onClick={onClose}
                style={{
                  ...btnStyle,
                  background: '#6c757d'
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div>
            {loadingHistory ? (
              <div style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>
                <div style={{ fontSize: 14 }}>Loading history...</div>
              </div>
            ) : history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>
                <div style={{ fontSize: 14, fontStyle: 'italic' }}>No transactions yet.</div>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={thStyleHistory}>Date</th>
                      <th style={thStyleHistory}>Type</th>
                      <th style={thStyleHistory}>Quantity</th>
                      <th style={thStyleHistory}>Reason</th>
                      <th style={thStyleHistory}>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((tx) => {
                      const t = TX_TYPES[tx.type] || { label: String(tx.type).toUpperCase(), bg: '#f3f4f6', color: '#374151', sign: 1 };
                      return (
                        <tr key={tx.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={tdStyle}>{fmtDbTime(tx.createdAt)}</td>
                          <td style={tdStyle}>
                            <span
                              style={{
                                padding: '3px 8px',
                                borderRadius: 4,
                                fontSize: 12,
                                fontWeight: 500,
                                background: t.bg,
                                color: t.color
                              }}
                            >
                              {t.label}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtChange(t.sign * tx.quantity)}</td>
                          <td style={tdStyle}>{tx.reason || '-'}</td>
                          <td style={tdStyle}>{tx.performedBy || 'system'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// Stock actions: what each one is called and its colours
const ACTIONS = [
  { value: 'add',      label: 'Add to Stock',   color: '#16a34a', bg: '#f0fdf4' },
  { value: 'subtract', label: 'Use from Stock', color: '#dc2626', bg: '#fef2f2' },
  { value: 'adjust',   label: 'Stock Count',    color: '#d97706', bg: '#fffbeb' },
];

// Styles
const tabBtn = {
  background: 'none',
  border: 'none',
  padding: '10px 16px',
  cursor: 'pointer',
  fontSize: 15,
  fontWeight: 600,
  marginBottom: -2
};

const fieldRow = {
  marginBottom: 16
};

const labelStyle = {
  display: 'block',
  marginBottom: 6,
  fontWeight: 600,
  fontSize: 14,
  color: '#374151'
};

const inputStyle = {
  width: '100%',
  padding: 10,
  fontSize: 14,
  borderRadius: 6,
  border: '1px solid #d1d5db',
  boxSizing: 'border-box'
};

const btnStyle = {
  padding: '10px 20px',
  fontSize: 14,
  fontWeight: 600,
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  color: '#fff'
};

const thStyle = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 600,
  color: '#374151'
};

const thStyleHistory = {
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
  color: '#1f2937'
};
