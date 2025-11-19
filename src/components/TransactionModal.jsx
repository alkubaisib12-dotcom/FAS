// src/components/TransactionModal.jsx
import React, { useState, useEffect } from 'react';
import { addConsumableTransaction, getConsumableTransactions } from '../utils/api';
import Modal from './Modal';

export default function TransactionModal({ item, onClose, onSuccess }) {
  const [activeTab, setActiveTab] = useState('transaction'); // 'transaction' | 'history'
  const [type, setType] = useState('subtract'); // 'add' | 'subtract'
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

  const handleSubmit = async (e) => {
    e.preventDefault();

    const qty = parseInt(quantity);
    if (!qty || qty <= 0) {
      alert('Please enter a valid quantity');
      return;
    }

    if (type === 'subtract' && qty > item.quantity) {
      alert(`Cannot subtract ${qty}. Only ${item.quantity} available in stock.`);
      return;
    }

    setLoading(true);
    try {
      const result = await addConsumableTransaction(item.id, type, qty, reason);
      alert(`Success! Quantity ${type === 'add' ? 'added' : 'subtracted'}.\nPrevious: ${result.previousQuantity}\nNew: ${result.newQuantity}`);
      setQuantity('');
      setReason('');
      if (onSuccess) onSuccess();
    } catch (err) {
      alert('Transaction failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  return (
    <Modal isOpen={true} onClose={onClose}>
      <div style={{ minWidth: 600, maxWidth: 800 }}>
        <h3 style={{ marginTop: 0, marginBottom: 20 }}>
          {item.name} (ID: {item.id})
        </h3>

        <div style={{ marginBottom: 20, padding: 12, background: '#f3f4f6', borderRadius: 8 }}>
          <div style={{ fontSize: 14, color: '#6b7280' }}>Current Stock:</div>
          <div style={{ fontSize: 28, fontWeight: 'bold', color: '#111827' }}>{item.quantity}</div>
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
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="type"
                    value="add"
                    checked={type === 'add'}
                    onChange={(e) => setType(e.target.value)}
                  />
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>➕ Add to Stock</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="type"
                    value="subtract"
                    checked={type === 'subtract'}
                    onChange={(e) => setType(e.target.value)}
                  />
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>➖ Use from Stock</span>
                </label>
              </div>
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Quantity *</label>
              <input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                style={inputStyle}
                placeholder="Enter quantity"
                required
                autoFocus
              />
              {type === 'subtract' && quantity && parseInt(quantity) > item.quantity && (
                <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>
                  ⚠️ Insufficient stock! Only {item.quantity} available.
                </div>
              )}
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Reason / Notes</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ ...inputStyle, minHeight: 80 }}
                placeholder={type === 'add' ? 'e.g., Received new shipment' : 'e.g., Used for project XYZ, Assigned to John Doe'}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                type="submit"
                disabled={loading}
                style={{
                  ...btnStyle,
                  background: type === 'add' ? '#16a34a' : '#dc2626',
                  opacity: loading ? 0.6 : 1
                }}
              >
                {loading ? 'Processing...' : type === 'add' ? 'Add to Stock' : 'Use from Stock'}
              </button>
              <button type="button" onClick={onClose} style={{ ...btnStyle, background: '#6c757d' }}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div>
            {loadingHistory ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#6b7280' }}>
                Loading history...
              </div>
            ) : history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af', fontStyle: 'italic' }}>
                No transactions yet.
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
                    <tr>
                      <th style={thStyle}>Date</th>
                      <th style={thStyle}>Type</th>
                      <th style={thStyle}>Quantity</th>
                      <th style={thStyle}>Reason</th>
                      <th style={thStyle}>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((tx) => (
                      <tr key={tx.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <td style={tdStyle}>{formatDate(tx.createdAt)}</td>
                        <td style={tdStyle}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 12,
                              fontWeight: 600,
                              background: tx.type === 'add' ? '#d1fae5' : '#fee2e2',
                              color: tx.type === 'add' ? '#065f46' : '#991b1b'
                            }}
                          >
                            {tx.type === 'add' ? '➕ ADD' : '➖ USE'}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{tx.quantity}</td>
                        <td style={tdStyle}>{tx.reason || '-'}</td>
                        <td style={tdStyle}>{tx.performedBy || 'system'}</td>
                      </tr>
                    ))}
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
  border: '1px solid #d1d5db'
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

const tdStyle = {
  padding: '10px 12px',
  fontSize: 14,
  color: '#1f2937'
};
