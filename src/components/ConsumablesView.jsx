// src/components/ConsumablesView.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { consumableCategories } from '../data/consumableCategories';
import Modal from './Modal';
import CustomFieldManager from './CustomFieldManager';
import TransactionModal from './TransactionModal';
import ConsumableLog from './ConsumableLog';

const OTHER_CATEGORY = '__other__'; // the "Other (new category)" choice in the category list

// Columns with a ▾ filter, as on the asset list. Custom fields get one too, keyed "cf:<name>".
const FILTER_FIELDS = { category: 'Category', stock: 'Stock', company: 'Company' };

// The value an item is filtered on for a column
function filterValue(item, field) {
  if (field === 'stock') return item.archived ? 'Archived' : item.quantity > 0 ? 'In stock' : 'Out of stock';
  if (field.startsWith('cf:')) return item.customFields?.[field.slice(3)];
  return item[field];
}

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
  const [showLog, setShowLog] = useState(false);

  // Column filters: { field: [selected values] }, and the open ▾ list
  const [filter, setFilter] = useState({});
  const [dropdown, setDropdown] = useState({ field: null, open: false });
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef();

  // Form state
  const emptyForm = { id: '', name: '', category: '', quantity: 0, company: '', customFields: {} };
  const [formData, setFormData] = useState(emptyForm);
  const [otherCategory, setOtherCategory] = useState(''); // typed when "Other" is chosen
  const idPreviewSeq = useRef(0); // ignores an ID preview that arrives after a newer one

  // The standard categories, then any other category already used by an item
  const categoryOptions = useMemo(() => {
    const known = new Set(consumableCategories.map(c => c.toLowerCase()));
    const extra = [...new Set(consumables.map(i => i.category).filter(Boolean))]
      .filter(c => !known.has(c.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    return [...consumableCategories, ...extra];
  }, [consumables]);

  useEffect(() => {
    loadData();
  }, [showArchived]);

  // Close the ▾ list on an outside click or Esc
  useEffect(() => {
    if (!dropdown.open) return undefined;
    const onDocClick = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) closeDropdown(); };
    const onKey = (e) => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [dropdown.open]);

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

  // A new item's ID comes from its category (Toner → TON-004), so it is shown once one is chosen
  const handleAddNew = () => {
    idPreviewSeq.current++;
    setFormData(emptyForm);
    setOtherCategory('');
    setEditingItem(null);
    setShowAddForm(true);
  };

  const handleEdit = (item) => {
    setFormData({
      id: item.id,
      name: item.name,
      category: item.category || '',
      quantity: item.quantity,
      company: item.company || '',
      customFields: item.customFields || {}
    });
    setOtherCategory('');
    setEditingItem(item);
    setShowAddForm(true);
  };

  // Show the next ID for the chosen category. The add itself takes the next free number,
  // so the saved ID can differ if someone adds to the same category first.
  const previewId = async (category) => {
    const seq = ++idPreviewSeq.current;
    if (!category) {
      setFormData(prev => ({ ...prev, id: '' }));
      return;
    }
    try {
      const id = await getNextConsumableId(category);
      if (seq === idPreviewSeq.current) setFormData(prev => ({ ...prev, id }));
    } catch (err) {
      if (seq === idPreviewSeq.current) setFormData(prev => ({ ...prev, id: '' }));
    }
  };

  const handleCategoryChange = (value) => {
    setFormData(prev => ({ ...prev, category: value }));
    if (editingItem) return; // an existing item keeps its ID
    if (value === OTHER_CATEGORY) {
      setOtherCategory('');
      previewId('');
    } else {
      previewId(value);
    }
  };

  const handleOtherCategoryChange = (value) => {
    setOtherCategory(value);
    if (!editingItem) previewId(value.trim());
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
    const category = formData.category === OTHER_CATEGORY ? otherCategory.trim() : formData.category;
    if (!editingItem && !category) {
      alert('Choose a category, or choose "Other" and type a new one');
      return;
    }

    try {
      if (editingItem) {
        // Stock is not saved from this form; it changes only through "± Stock" so it is in the history
        const { quantity, ...details } = formData;
        await updateConsumable(formData.id, { ...details, category });
        alert('Item updated');
      } else {
        // No id: the server gives the next free ID for the category
        const { id, ...details } = formData;
        const result = await addConsumable({ ...details, category });
        alert(`Item added as ${result.id}`);
      }
      setShowAddForm(false);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleCancel = () => {
    idPreviewSeq.current++;
    setShowAddForm(false);
    setFormData(emptyForm);
    setOtherCategory('');
    setEditingItem(null);
  };

  const handleCustomFieldChange = (fieldName, value) => {
    setFormData(prev => ({
      ...prev,
      customFields: { ...prev.customFields, [fieldName]: value }
    }));
  };

  /* ---- Search and column filters (same behaviour as the asset list) ---- */
  const filterLabel = (field) => FILTER_FIELDS[field] || field.slice(3);

  // Every value the column has, plus anything already ticked, so a selection never disappears
  const uniqueValues = (field) => {
    if (field === 'stock') {
      return ['In stock', 'Out of stock', ...(showArchived ? ['Archived'] : [])];
    }
    const vals = consumables
      .map(item => filterValue(item, field))
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      .map(String);
    return Array.from(new Set([...vals, ...(filter[field] || [])])).sort((a, b) => a.localeCompare(b));
  };

  const toggleDropdown = (e, field) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setDropdown({ field, open: true });
    setDropdownPosition({ top: rect.bottom, left: rect.left });
  };
  const closeDropdown = () => setDropdown(prev => ({ ...prev, open: false }));

  const handleCheckboxChange = (field, value) => {
    setFilter(prev => {
      const current = prev[field] || [];
      const updated = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      return { ...prev, [field]: updated };
    });
  };
  const clearFilter = (field) => setFilter(prev => ({ ...prev, [field]: [] }));
  const clearAllFilters = () => {
    setSearchText('');
    setFilter({});
  };

  const search = searchText.trim().toLowerCase();
  const filteredItems = consumables.filter(item => {
    const columnsMatch = Object.entries(filter).every(
      ([field, vals]) => !vals.length || vals.includes(String(filterValue(item, field) ?? ''))
    );
    if (!columnsMatch) return false;
    if (!search) return true;
    return [item.id, item.name, item.category, item.company, ...Object.values(item.customFields || {})]
      .some(v => String(v ?? '').toLowerCase().includes(search));
  });

  // "Filtering by:" chips, one per search or ticked value, each removable
  const activeChips = [];
  if (search) activeChips.push({ key: 'search', label: `Search: "${searchText.trim()}"`, onRemove: () => setSearchText('') });
  Object.entries(filter).forEach(([field, vals]) => {
    vals.forEach(value => activeChips.push({
      key: `${field}:${value}`,
      label: `${filterLabel(field)}: ${value}`,
      onRemove: () => handleCheckboxChange(field, value),
    }));
  });
  const hasActiveFilters = activeChips.length > 0;

  // A column header that opens its ▾ filter list
  const filterTh = (field, label) => {
    const count = (filter[field] || []).length;
    return (
      <th
        key={field}
        style={{ ...thStyle, cursor: 'pointer', whiteSpace: 'nowrap', background: count ? 'rgba(15, 23, 42, 0.25)' : undefined }}
        onClick={(e) => toggleDropdown(e, field)}
        title={`Filter by ${label}`}
      >
        {label}{count ? ` (${count})` : ''} ▾
      </th>
    );
  };

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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by ID, Name, Category, Company..."
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
        <button onClick={() => setShowLog(true)} style={btnStyle('secondary')}>
          Stock Log
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

      {/* Active search/filter indicator — always visible while filtering */}
      {hasActiveFilters && (
        <div style={activeBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 'bold', color: '#555' }}>Filtering by:</span>
          {activeChips.map(chip => (
            <span key={chip.key} style={chipStyle}>
              {chip.label}
              <button onClick={chip.onRemove} style={chipRemoveStyle} aria-label={`Remove ${chip.label}`} title="Remove this filter">×</button>
            </span>
          ))}
          <button onClick={clearAllFilters} style={clearAllBtnStyle}>Clear all</button>
        </div>
      )}

      {/* Result count — visible even when nothing matches */}
      <div style={{ marginBottom: 12, fontSize: 14, color: '#555' }}>
        {hasActiveFilters
          ? (filteredItems.length === 0
              ? 'No items match your search/filters.'
              : `${filteredItems.length} result${filteredItems.length === 1 ? '' : 's'} found`)
          : `${consumables.length} item${consumables.length === 1 ? '' : 's'} total`}
      </div>

      {/* Table — headers with ▾ open a filter list */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          <thead style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)' }}>
            <tr>
              <th style={thStyle}>ID</th>
              <th style={thStyle}>Name</th>
              {filterTh('category', 'Category')}
              {filterTh('stock', 'Quantity')}
              {filterTh('company', 'Company')}
              {customFields.map(field => filterTh(`cf:${field.fieldName}`, field.fieldName))}
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={6 + customFields.length} style={{ padding: 30, textAlign: 'center', fontStyle: 'italic', color: '#999' }}>
                  {hasActiveFilters ? (
                    <>
                      <div>No items match your current search/filters.</div>
                      <button onClick={clearAllFilters} style={{ ...clearAllBtnStyle, marginTop: 10 }}>
                        Clear search &amp; filters
                      </button>
                    </>
                  ) : 'No items yet. Add your first item.'}
                </td>
              </tr>
            )}
            {filteredItems.map(item => (
              <tr
                key={item.id}
                style={{ borderBottom: '1px solid #ddd', color: item.archived ? '#9ca3af' : undefined }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f1f1')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{item.id}</td>
                <td style={tdStyle}>
                  {item.name}
                  {item.archived && <span style={archivedTagStyle}>Archived</span>}
                </td>
                <td style={tdStyle}>{item.category || '-'}</td>
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

      {/* The ▾ filter list for the column header that was clicked */}
      {dropdown.open && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed', top: dropdownPosition.top, left: dropdownPosition.left,
            zIndex: 1000, background: '#fff', border: '1px solid #ccc',
            borderRadius: 5, padding: 10, boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
            maxHeight: 320, overflowY: 'auto', minWidth: 160
          }}
        >
          {uniqueValues(dropdown.field).length === 0 && (
            <div style={{ fontSize: 12, color: '#999', padding: '4px 0' }}>No values available</div>
          )}
          {uniqueValues(dropdown.field).map(val => (
            <div key={val} style={{ marginBottom: 8 }}>
              <label style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={(filter[dropdown.field] || []).includes(val)}
                  onChange={() => handleCheckboxChange(dropdown.field, val)}
                  style={{ marginRight: 6 }}
                />
                {val}
              </label>
            </div>
          ))}
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <button onClick={() => clearFilter(dropdown.field)} style={{ fontSize: 12, color: '#007bff', border: 'none', background: 'transparent', cursor: 'pointer' }}>Clear Filter</button>
            <button onClick={closeDropdown} style={{ fontSize: 12, marginLeft: 10, color: '#28a745', border: 'none', background: 'transparent', cursor: 'pointer' }}>OK</button>
          </div>
        </div>
      )}

      {/* Stock log: every stock movement and item change, newest first */}
      {showLog && <ConsumableLog onClose={() => setShowLog(false)} />}

      {/* Add/Edit Form Modal */}
      <Modal isOpen={showAddForm} onClose={handleCancel}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <h3 style={{ marginTop: 0 }}>
            {editingItem ? 'Edit Item' : 'Add New Item'}
          </h3>
          <form onSubmit={handleSubmit}>
            <div style={fieldRow}>
              <label style={labelStyle}>Category {editingItem ? '' : '*'}</label>
              <select
                value={formData.category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                style={inputStyle}
                required={!editingItem}
                autoFocus={!editingItem}
              >
                <option value="">{editingItem ? '(no category)' : 'Choose a category'}</option>
                {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                <option value={OTHER_CATEGORY}>Other (new category)</option>
              </select>
              {formData.category === OTHER_CATEGORY && (
                <input
                  type="text"
                  value={otherCategory}
                  onChange={(e) => handleOtherCategoryChange(e.target.value)}
                  placeholder="New category name, e.g. Projector Lamps"
                  style={{ ...inputStyle, marginTop: 6 }}
                  required
                  autoFocus
                />
              )}
              {editingItem && <span style={hintStyle}>Changing the category keeps the item's ID.</span>}
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>ID</label>
              <input
                type="text"
                value={formData.id}
                readOnly
                placeholder="Choose a category to generate the ID"
                style={{ ...inputStyle, backgroundColor: '#f0f0f0' }}
              />
              {!editingItem && formData.id && (
                <span style={hintStyle}>The next free number for this category is given when you save.</span>
              )}
            </div>

            <div style={fieldRow}>
              <label style={labelStyle}>Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                style={inputStyle}
                required
                autoFocus={!!editingItem}
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
  fontWeight: '600',
  whiteSpace: 'nowrap'
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

// "Filtering by:" bar and chips — the same look as the asset list
const activeBarStyle = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 10px', background: '#eef4ff', border: '1px solid #cfe0ff', borderRadius: 6 };
const chipStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #b6d0ff', borderRadius: 999, padding: '4px 10px', fontSize: 13, color: '#1d4ed8' };
const chipRemoveStyle = { border: 'none', background: 'transparent', color: '#1d4ed8', cursor: 'pointer', fontWeight: 'bold', fontSize: 14, lineHeight: 1, padding: 0 };
const clearAllBtnStyle = { fontSize: 13, color: '#dc3545', border: '1px solid #dc3545', background: '#fff', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' };

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
