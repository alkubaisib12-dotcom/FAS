// src/components/AssetTable.jsx
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getAllAssets, deleteAsset, forceDeleteAsset } from '../utils/api';
import AssetForm from './AssetForm';
import SmartExportPanel from './SmartExportPanel';
import Modal from './Modal';

const PAGE_SIZE = 100;

export default function AssetTable({ refreshSignal, onEditStart, onEditEnd, backSignal }) {
  const [assets, setAssets]           = useState([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [loading, setLoading]         = useState(false);

  const [editingAsset, setEditingAsset] = useState(null);
  const [searchText, setSearchText]   = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filter, setFilter]           = useState({ group: [], assetType: [], department: [] });
  const [dropdown, setDropdown]       = useState({ field: null, open: false });
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exportAssets, setExportAssets] = useState([]);
  const [exportLoading, setExportLoading] = useState(false);

  const dropdownRef    = useRef();
  const editSectionRef = useRef(null);
  const highlightTimer = useRef(null);
  const debounceTimer  = useRef(null);

  // Debounce search text
  useEffect(() => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchText);
      setPage(1);
    }, 400);
    return () => clearTimeout(debounceTimer.current);
  }, [searchText]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [filter]);

  const loadAssets = useCallback(async (p) => {
    setLoading(true);
    try {
      const result = await getAllAssets({
        page: p,
        pageSize: PAGE_SIZE,
        search: debouncedSearch,
        group: filter.group,
        assetType: filter.assetType,
        department: filter.department,
      });
      setAssets(result.items ?? result);
      setTotal(result.total ?? (Array.isArray(result) ? result.length : 0));
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [debouncedSearch, filter]);

  useEffect(() => { loadAssets(page); }, [refreshSignal, page, loadAssets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll + highlight when entering edit
  useEffect(() => {
    if (editingAsset && editSectionRef.current) {
      editSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const el = editSectionRef.current;
      el.style.boxShadow = '0 0 0 3px #ffe58f';
      el.style.transition = 'box-shadow 600ms ease';
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => { el.style.boxShadow = 'none'; }, 1200);
    }
    return () => clearTimeout(highlightTimer.current);
  }, [editingAsset]);

  useEffect(() => {
    if (!backSignal) return;
    if (editingAsset) { setEditingAsset(null); onEditEnd && onEditEnd(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }, [backSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown on outside click / Esc
  useEffect(() => {
    if (!dropdown.open) return;
    const onDocClick = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) closeDropdown(); };
    const onKey = (e) => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [dropdown.open]);

  async function handleDelete(asset) {
    try {
      if (asset.assetId) await deleteAsset(asset.assetId);
      else await forceDeleteAsset({ macAddress: asset.macAddress, ipAddress: asset.ipAddress });
      alert('Asset deleted');
      loadAssets(page);
    } catch (err) {
      console.error(err);
      alert('Delete failed');
    }
  }

  const toggleDropdown = (e, field) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setDropdown({ field, open: true });
    setDropdownPosition({ top: rect.bottom, left: rect.left });
  };

  // Include current-page values + already-selected values so selections stay visible
  const uniqueValues = (field) => {
    const pageVals     = assets.map(a => a[field]).filter(Boolean);
    const selectedVals = filter[field] || [];
    return Array.from(new Set([...pageVals, ...selectedVals]));
  };

  const handleCheckboxChange = (field, value) => {
    setFilter(prev => {
      const updated = prev[field].includes(value)
        ? prev[field].filter(v => v !== value)
        : [...prev[field], value];
      return { ...prev, [field]: updated };
    });
  };

  const clearFilter   = (field) => setFilter(prev => ({ ...prev, [field]: [] }));
  const closeDropdown = () => setDropdown(prev => ({ ...prev, open: false }));

  const startEdit = (asset) => { setEditingAsset(asset); onEditStart && onEditStart(); };
  const endEdit   = (refresh = false) => {
    setEditingAsset(null);
    onEditEnd && onEditEnd();
    if (refresh) loadAssets(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Fetch all matching assets (no page limit) for export
  const handleOpenExport = async () => {
    setExportLoading(true);
    try {
      const result = await getAllAssets({
        search: debouncedSearch,
        group: filter.group,
        assetType: filter.assetType,
        department: filter.department,
      });
      setExportAssets(Array.isArray(result) ? result : (result.items ?? []));
      setShowExportPanel(true);
    } catch (err) {
      console.error(err);
      alert('Failed to load export data');
    }
    setExportLoading(false);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ padding: '20px', background: '#f9f9f9', borderRadius: '10px' }}>
      <h2 style={{ marginBottom: '10px', fontSize: '24px' }}>Asset List</h2>

      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Search by Asset ID, Serial, Brand, or text in photos…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ padding: '6px', width: '300px' }}
        />
      </div>

      <button
        onClick={handleOpenExport}
        disabled={exportLoading}
        style={{
          background: 'green', color: '#fff', padding: '8px 16px',
          border: 'none', borderRadius: '5px', marginBottom: '20px', cursor: 'pointer'
        }}
      >
        {exportLoading ? 'Loading…' : 'Export to Excel'}
      </button>

      <Modal isOpen={showExportPanel} onClose={() => setShowExportPanel(false)}>
        <h3 style={{ marginTop: 0, textAlign: 'center' }}>Export Assets</h3>
        <SmartExportPanel assets={exportAssets} />
      </Modal>

      {editingAsset && (
        <div ref={editSectionRef} style={{ marginBottom: '20px', background: '#fffbe6', padding: '15px', borderRadius: '8px' }}>
          <h3 style={{ marginTop: 0 }}>Edit Asset: {editingAsset.assetId}</h3>
          <AssetForm
            editData={editingAsset}
            onSave={() => endEdit(true)}
            onCancel={() => endEdit(false)}
            onDeleted={() => endEdit(true)}
          />
        </div>
      )}

      {loading ? (
        <p style={{ fontStyle: 'italic', color: '#999' }}>Loading…</p>
      ) : assets.length === 0 ? (
        <p style={{ fontStyle: 'italic', color: '#999' }}>No assets found.</p>
      ) : (
        <div style={{ overflowX: 'auto', position: 'relative' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
            <thead style={{ background: '#e9ecef' }}>
              <tr>
                <th style={thStyle}>Asset ID</th>
                <th style={thStyle} onClick={(e) => toggleDropdown(e, 'group')}>Group ▾</th>
                <th style={thStyle} onClick={(e) => toggleDropdown(e, 'assetType')}>Asset Type ▾</th>
                <th style={thStyle}>Brand</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Serial Number</th>
                <th style={thStyle}>Host Name</th>
                <th style={thStyle}>Assigned To</th>
                <th style={thStyle} onClick={(e) => toggleDropdown(e, 'department')}>Department ▾</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr
                  key={asset.assetId}
                  style={{ borderBottom: '1px solid #ddd', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f1f1')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  <td style={tdStyle}>{asset.assetId}</td>
                  <td style={tdStyle}>{asset.group}</td>
                  <td style={tdStyle}>{asset.assetType}</td>
                  {(() => {
                    const bm  = (asset.brandModel || '').trim();
                    const idx = bm.indexOf(' ');
                    const b   = idx > -1 ? bm.slice(0, idx).trim() : bm;
                    const m   = idx > -1 ? bm.slice(idx + 1).trim() : '';
                    return (<><td style={tdStyle}>{b || '-'}</td><td style={tdStyle}>{m || '-'}</td></>);
                  })()}
                  <td style={tdStyle}>{asset.serialNumber}</td>
                  <td style={tdStyle}>{asset.hostName || '-'}</td>
                  <td style={tdStyle}>{asset.assignedTo}</td>
                  <td style={tdStyle}>{asset.department || '-'}</td>
                  <td style={tdStyle}>
                    <button onClick={() => startEdit(asset)} style={editBtnStyle}>Edit</button>
                    <button onClick={() => handleDelete(asset)} style={deleteBtnStyle}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', fontSize: '14px' }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={pageBtnStyle}>← Prev</button>
            <span>Page {page} of {totalPages} &nbsp;·&nbsp; {total} total assets</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={pageBtnStyle}>Next →</button>
          </div>

          {dropdown.open && (
            <div
              ref={dropdownRef}
              style={{
                position: 'fixed', top: dropdownPosition.top, left: dropdownPosition.left,
                zIndex: 1000, background: '#fff', border: '1px solid #ccc',
                borderRadius: '5px', padding: '10px', boxShadow: '0 4px 10px rgba(0,0,0,0.1)'
              }}
            >
              {uniqueValues(dropdown.field).map((val) => (
                <div key={val} style={{ marginBottom: '8px' }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={filter[dropdown.field].includes(val)}
                      onChange={() => handleCheckboxChange(dropdown.field, val)}
                      style={{ marginRight: '6px' }}
                    />
                    {val}
                  </label>
                </div>
              ))}
              <div style={{ textAlign: 'center', marginTop: '10px' }}>
                <button onClick={() => clearFilter(dropdown.field)} style={{ fontSize: '12px', color: '#007bff', border: 'none', background: 'transparent', cursor: 'pointer' }}>Clear Filter</button>
                <button onClick={closeDropdown} style={{ fontSize: '12px', marginLeft: '10px', color: '#28a745', border: 'none', background: 'transparent', cursor: 'pointer' }}>OK</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle      = { padding: '10px', textAlign: 'left', fontWeight: 'bold', fontSize: '14px', borderBottom: '2px solid #ccc', cursor: 'pointer', position: 'relative' };
const tdStyle      = { padding: '10px', fontSize: '14px', verticalAlign: 'top' };
const editBtnStyle   = { background: '#007bff', color: '#fff', padding: '5px 10px', marginRight: '5px', border: 'none', borderRadius: '4px', cursor: 'pointer' };
const deleteBtnStyle = { background: '#dc3545', color: '#fff', padding: '5px 10px', border: 'none', borderRadius: '4px', cursor: 'pointer' };
const pageBtnStyle   = { padding: '4px 12px', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', background: '#fff' };
