// src/components/ConsumablesView.jsx
import React, { useEffect, useState } from 'react';
import {
  getAllConsumables,
  getNextConsumableId,
  addConsumable,
  updateConsumable,
  deleteConsumable,
  restoreConsumable,
  getConsumableFields,
} from '../utils/api';
import { exportConsumablesToExcel } from '../utils/exportUtils';
import Modal from './Modal';
import CustomFieldManager from './CustomFieldManager';
import TransactionModal from './TransactionModal';

export default function ConsumablesView() {
  const [consumables, setConsumables] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFieldManager, setShowFieldManager] = useState(false);
  const [showTransactionModal, setShowTransactionModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    id: '',
    name: '',
    quantity: 0,
    company: '',
    customFields: {}
  });

  useEffect(() => {
    loadData();
  }, [showArchived]);

  // Only the first load shows "Loading..."; later reloads keep the page (and an open stock
  // window) on screen. Hiding the page unmounted the stock window, which then came back
  // showing the stock from before the change.
  const loadData = async () => {
    try {
      const [items, fields] = await Promise.all([
        getAllConsumables({ includeArchived: showArchived }),
        getConsumableFields()
      ]);
      setConsumables(items || []);
      setCustomFields(fields || []);
      // Keep the open stock window on the item's current stock
      setSelectedItem(prev => (prev && (items || []).find(i => i.id === prev.id)) || prev);
    } catch (err) {
      console.error('Error loading consumables:', err);
      alert('Failed to load consumables: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddNew = async () => {
    try {
      const nextId = await getNextConsumableId();
      setFormData({
        id: nextId,
        name: '',
        quantity: 0,
        company: '',
        customFields: {}
      });
      setEditingItem(null);
      setShowAddForm(true);
    } catch (err) {
      alert('Failed to generate ID: ' + err.message);
    }
  };

  const handleEdit = (item) => {
    setFormData({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      company: item.company || '',
      customFields: item.customFields || {}
    });
    setEditingItem(item);
    setShowAddForm(true);
  };

  const handleArchive = async (id) => {
    if (!window.confirm('Archive this item?\n\nIt leaves the list and its stock can no longer change. Its history is kept, and you can restore it with "Show archived".')) return;
    try {
      await deleteConsumable(id);
      alert('Item archived');
      loadData();
    } catch (err) {
      alert('Archive failed: ' + err.message);
    }
  };

  const handleRestore = async (id) => {
    try {
      await restoreConsumable(id);
      loadData();
    } catch (err) {
      alert('Restore failed: ' + err.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      alert('Name is required');
      return;
    }

    try {
      if (editingItem) {
        // Stock is not saved from this form; it changes only through "± Stock" so it is in the history
        const { quantity, ...details } = formData;
        await updateConsumable(formData.id, details);
        alert('Item updated');
      } else {
        await addConsumable(formData);
        alert('Item added');
      }
      setShowAddForm(false);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleCancel = () => {
    setShowAddForm(false);
    setFormData({ id: '', name: '', quantity: 0, company: '', customFields: {} });
    setEditingItem(null);
  };

  const handleCustomFieldChange = (fieldName, value) => {
    setFormData(prev => ({
      ...prev,
      customFields: { ...prev.customFields, [fieldName]: value }
    }));
  };

  // Filter consumables
  const filteredItems = consumables.filter(item => {
    if (!searchText.trim()) return true;
    const search = searchText.toLowerCase();
    return (
      (item.id || '').toLowerCase().includes(search) ||
      (item.name || '').toLowerCase().includes(search) ||
      (item.company || '').toLowerCase().includes(search)
    );
  });

  const handleExport = () => {
    if (filteredItems.length === 0) {
      alert('No items to export');
      return;
    }
    exportConsumablesToExcel(filteredItems, customFields, 'consumables_export.xlsx');
  };

  const handleOpenTransaction = (item) => {
    setSelectedItem(item);
    setShowTransactionModal(true);
  };

  const handleTransactionSuccess = () => {
    loadData(); // Reload to get updated quantities
  };

  if (loading) return <div style={{ padding: 20 }}>Loading...</div>;

  return (
    <div style={{ padding: 20 }}>
      {/* Consumables Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)',
        padding: '16px 24px',
        borderRadius: 6,
        marginBottom: 20
      }}>
        <h2 style={{ margin: 0, color: '#fff', fontSize: 24, fontWeight: 600 }}>
          Consumables Store
        </h2>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by ID, Name, Company..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ padding: '8px', width: 300, borderRadius: 5, border: '1px solid #ccc' }}
        />
        <button onClick={handleAddNew} style={btnStyle('primary')}>
          Add New Item
        </button>
        <button onClick={() => setShowFieldManager(true)} style={btnStyle('secondary')}>
          Manage Custom Fields
        </button>
        <button onClick={handleExport} style={btnStyle('export')}>
          Export to Excel
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer', color: '#374151' }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {/* Table */}
      {filteredItems.length === 0 ? (
        <p style={{ fontStyle: 'italic', color: '#999' }}>No items found.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
            <thead style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)' }}>
              <tr>
                <th style={thStyle}>ID</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Quantity</th>
                <th style={thStyle}>Company</th>
                {customFields.map(field => (
                  <th key={field.fieldName} style={thStyle}>{field.fieldName}</th>
                ))}
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => (
                <tr
                  key={item.id}
                  style={{ borderBottom: '1px solid #ddd', color: item.archived ? '#9ca3af' : undefined }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f1f1')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td style={tdStyle}>{item.id}</td>
                  <td style={tdStyle}>
                    {item.name}
                    {item.archived && <span style={archivedTagStyle}>Archived</span>}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 'bold', fontSize: 16 }}>{item.quantity}</span>
                      {!item.archived && (
                        <button
                          onClick={() => handleOpenTransaction(item)}
                          style={stockBtnStyle}
                          title="Add, use or count stock"
                        >
                          ± Stock
                        </button>
                      )}
                    </div>
                  </td>
                  <td style={tdStyle}>{item.company || '-'}</td>
                  {customFields.map(field => (
                    <td key={field.fieldName} style={tdStyle}>
                      {item.customFields?.[field.fieldName] || '-'}
                    </td>
                  ))}
                  <td style={tdStyle}>
                    {item.archived ? (
                      <button onClick={() => handleRestore(item.id)} style={actionBtnStyle('restore')}>
                        Restore
                      </button>
                    ) : (
                      <>
                        <button onClick={() => handleEdit(item)} style={actionBtnStyle('edit')}>
                          Edit
                        </button>
                        <button onClick={() => handleArchive(item.id)} style={actionBtnStyle('archive')}>
                          Archive
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Form Modal */}
      <Modal isOpen={showAddForm} onClose={handleCancel}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <h3 style={{ marginTop: 0 }}>
            {editingItem ? 'Edit Item' : 'Add New Item'}
          </h3>
          <form onSubmit={handleSubmit}>
            <div style={fieldRow}>
              <label style={labelStyle}>ID *</label>
              <input
                type="text"
                value={formData.id}
                readOnly
                style={{ ...inputStyle, backgroundColor: '#f0f0f0' }}
              />
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                style={inputStyle}
                required
                autoFocus
              />
            </div>

            {editingItem ? (
              <div style={fieldRow}>
                <label style={labelStyle}>Stock</label>
                <input
                  type="text"
                  value={formData.quantity}
                  readOnly
                  style={{ ...inputStyle, backgroundColor: '#f0f0f0' }}
                />
                <span style={hintStyle}>
                  Change stock with "± Stock" in the list, so every change is recorded in the history.
                </span>
              </div>
            ) : (
              <div style={fieldRow}>
                <label style={labelStyle}>Opening stock</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={formData.quantity}
                  onChange={(e) => setFormData({ ...formData, quantity: Math.max(0, parseInt(e.target.value) || 0) })}
                  style={inputStyle}
                />
                <span style={hintStyle}>Recorded as the first entry in the item's history.</span>
              </div>
            )}

            <div style={fieldRow}>
              <label style={labelStyle}>Company / Vendor</label>
              <input
                type="text"
                value={formData.company}
                onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                style={inputStyle}
              />
            </div>

            {/* Dynamic custom fields */}
            {customFields.map(field => (
              <div key={field.fieldName} style={fieldRow}>
                <label style={labelStyle}>
                  {field.fieldName} {field.required ? '*' : ''}
                </label>
                <input
                  type={field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text'}
                  value={formData.customFields[field.fieldName] || ''}
                  onChange={(e) => handleCustomFieldChange(field.fieldName, e.target.value)}
                  style={inputStyle}
                  required={field.required}
                />
              </div>
            ))}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button type="submit" style={btnStyle('primary')}>
                {editingItem ? 'Update' : 'Add'}
              </button>
              <button type="button" onClick={handleCancel} style={btnStyle('secondary')}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Custom Field Manager Modal */}
      <Modal isOpen={showFieldManager} onClose={() => setShowFieldManager(false)}>
        <CustomFieldManager
          fields={customFields}
          onUpdate={() => {
            loadData();
          }}
          onClose={() => setShowFieldManager(false)}
        />
      </Modal>

      {/* Transaction Modal */}
      {showTransactionModal && selectedItem && (
        <TransactionModal
          item={selectedItem}
          onClose={() => {
            setShowTransactionModal(false);
            setSelectedItem(null);
          }}
          onSuccess={handleTransactionSuccess}
        />
      )}
    </div>
  );
}

// Styles
const thStyle = {
  padding: 12,
  textAlign: 'left',
  fontWeight: 'bold',
  fontSize: 14,
  color: '#fff',
  borderBottom: '2px solid rgba(255, 255, 255, 0.3)'
};

const tdStyle = {
  padding: 10,
  fontSize: 14
};

const btnStyle = (variant) => ({
  padding: '8px 16px',
  fontSize: 14,
  border: 'none',
  borderRadius: 5,
  cursor: 'pointer',
  background: variant === 'primary' ? '#2563eb' : variant === 'export' ? '#0ea5e9' : '#6c757d',
  color: '#fff',
  fontWeight: '600'
});

const actionBtnStyle = (type) => ({
  padding: '5px 10px',
  marginRight: 5,
  fontSize: 13,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  background: type === 'edit' ? '#2563eb' : type === 'restore' ? '#16a34a' : '#6b7280',
  color: '#fff'
});

const archivedTagStyle = {
  marginLeft: 8,
  padding: '2px 6px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: '#e5e7eb',
  color: '#4b5563'
};

const hintStyle = {
  marginTop: 4,
  fontSize: 12,
  color: '#6b7280'
};

const stockBtnStyle = {
  padding: '4px 8px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid #2563eb',
  borderRadius: 4,
  cursor: 'pointer',
  background: '#fff',
  color: '#2563eb'
};

const fieldRow = {
  display: 'flex',
  flexDirection: 'column',
  marginBottom: 12
};

const labelStyle = {
  marginBottom: 4,
  fontWeight: 500,
  fontSize: 14
};

const inputStyle = {
  padding: 8,
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid #ccc'
};
