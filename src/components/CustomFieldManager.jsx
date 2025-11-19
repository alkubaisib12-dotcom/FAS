// src/components/CustomFieldManager.jsx
import React, { useState } from 'react';
import { addConsumableField, deleteConsumableField } from '../utils/api';

export default function CustomFieldManager({ fields, onUpdate, onClose }) {
  const [newField, setNewField] = useState({
    fieldName: '',
    fieldType: 'text',
    required: false
  });

  const handleAddField = async (e) => {
    e.preventDefault();

    if (!newField.fieldName.trim()) {
      alert('Field name is required');
      return;
    }

    // Validate field name (alphanumeric + spaces only)
    if (!/^[a-zA-Z0-9\s]+$/.test(newField.fieldName)) {
      alert('Field name can only contain letters, numbers, and spaces');
      return;
    }

    try {
      await addConsumableField(newField);
      alert('Field added successfully');
      setNewField({ fieldName: '', fieldType: 'text', required: false });
      onUpdate();
    } catch (err) {
      alert('Failed to add field: ' + err.message);
    }
  };

  const handleDeleteField = async (fieldName) => {
    if (!window.confirm(`Are you sure you want to delete the field "${fieldName}"? This will remove the field from all items.`)) {
      return;
    }

    try {
      await deleteConsumableField(fieldName);
      alert('Field deleted successfully');
      onUpdate();
    } catch (err) {
      alert('Failed to delete field: ' + err.message);
    }
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <h3 style={{ marginTop: 0 }}>Manage Custom Fields</h3>
      <p style={{ color: '#6b7280', marginBottom: 20 }}>
        Add custom columns to track additional information for your consumables.
      </p>

      {/* Add New Field Form */}
      <div style={{ background: '#f9fafb', padding: 20, borderRadius: 8, marginBottom: 20 }}>
        <h4 style={{ marginTop: 0, marginBottom: 15 }}>Add New Field</h4>
        <form onSubmit={handleAddField}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label style={labelStyle}>Field Name *</label>
              <input
                type="text"
                placeholder="e.g., Location, Expiry Date, Supplier"
                value={newField.fieldName}
                onChange={(e) => setNewField({ ...newField, fieldName: e.target.value })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Field Type *</label>
              <select
                value={newField.fieldType}
                onChange={(e) => setNewField({ ...newField, fieldType: e.target.value })}
                style={inputStyle}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="required"
                checked={newField.required}
                onChange={(e) => setNewField({ ...newField, required: e.target.checked })}
              />
              <label htmlFor="required" style={{ margin: 0, cursor: 'pointer' }}>
                Required field
              </label>
            </div>

            <button type="submit" style={btnStyle('primary')}>
              Add Field
            </button>
          </div>
        </form>
      </div>

      {/* Existing Fields List */}
      <div>
        <h4 style={{ marginBottom: 10 }}>Current Custom Fields ({fields.length})</h4>
        {fields.length === 0 ? (
          <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>
            No custom fields yet. Add your first field above.
          </p>
        ) : (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#f3f4f6' }}>
                <tr>
                  <th style={thStyle}>Field Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Required</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.fieldName} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={tdStyle}>{field.fieldName}</td>
                    <td style={tdStyle}>
                      <span style={{
                        background: '#e0e7ff',
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        color: '#3730a3'
                      }}>
                        {field.fieldType}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {field.required ? (
                        <span style={{ color: '#dc2626', fontWeight: 600 }}>Yes</span>
                      ) : (
                        <span style={{ color: '#6b7280' }}>No</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <button
                        onClick={() => handleDeleteField(field.fieldName)}
                        style={deleteBtn}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Styles
const labelStyle = {
  display: 'block',
  marginBottom: 4,
  fontWeight: 500,
  fontSize: 14
};

const inputStyle = {
  width: '100%',
  padding: 8,
  fontSize: 14,
  borderRadius: 4,
  border: '1px solid #d1d5db'
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

const deleteBtn = {
  padding: '4px 12px',
  fontSize: 13,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  background: '#ef4444',
  color: '#fff'
};

const thStyle = {
  padding: 12,
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 600,
  color: '#374151'
};

const tdStyle = {
  padding: 12,
  fontSize: 14,
  color: '#1f2937'
};
