// src/components/ConsumablesView.jsx
import React, { useEffect, useState } from 'react';
import {
  getAllConsumables,
  getNextConsumableId,
  addConsumable,
  updateConsumable,
  deleteConsumable,
  getConsumableFields,
} from '../utils/api';
import Modal from './Modal';
import CustomFieldManager from './CustomFieldManager';

export default function ConsumablesView() {
  const [consumables, setConsumables] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFieldManager, setShowFieldManager] = useState(false);
  const [searchText, setSearchText] = useState('');

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
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [items, fields] = await Promise.all([
        getAllConsumables(),
        getConsumableFields()
      ]);
      setConsumables(items || []);
      setCustomFields(fields || []);
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

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this item?')) return;
    try {
      await deleteConsumable(id);
      alert('Item deleted');
      loadData();
    } catch (err) {
      alert('Delete failed: ' + err.message);
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
        await updateConsumable(formData.id, formData);
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

  if (loading) return <div style={{ padding: 20 }}>Loading...</div>;

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ marginBottom: 20 }}>Consumables Store</h2>

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
      </div>

      {/* Table */}
      {filteredItems.length === 0 ? (
        <p style={{ fontStyle: 'italic', color: '#999' }}>No items found.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
            <thead style={{ background: '#e9ecef' }}>
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
                  style={{ borderBottom: '1px solid #ddd' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f1f1')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td style={tdStyle}>{item.id}</td>
                  <td style={tdStyle}>{item.name}</td>
                  <td style={tdStyle}>{item.quantity}</td>
                  <td style={tdStyle}>{item.company || '-'}</td>
                  {customFields.map(field => (
                    <td key={field.fieldName} style={tdStyle}>
                      {item.customFields?.[field.fieldName] || '-'}
                    </td>
                  ))}
                  <td style={tdStyle}>
                    <button onClick={() => handleEdit(item)} style={actionBtnStyle('edit')}>
                      Edit
                    </button>
                    <button onClick={() => handleDelete(item.id)} style={actionBtnStyle('delete')}>
                      Delete
                    </button>
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

            <div style={fieldRow}>
              <label style={labelStyle}>Quantity</label>
              <input
                type="number"
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })}
                style={inputStyle}
              />
            </div>

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
    </div>
  );
}

// Styles
const thStyle = {
  padding: 10,
  textAlign: 'left',
  fontWeight: 'bold',
  fontSize: 14,
  borderBottom: '2px solid #ccc'
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
  background: variant === 'primary' ? '#28a745' : '#6c757d',
  color: '#fff'
});

const actionBtnStyle = (type) => ({
  padding: '5px 10px',
  marginRight: 5,
  fontSize: 13,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  background: type === 'edit' ? '#007bff' : '#dc3545',
  color: '#fff'
});

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
