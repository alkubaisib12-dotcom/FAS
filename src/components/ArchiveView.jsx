// src/components/ArchiveView.jsx — the document archive: search and filter the scanned papers,
// upload new scans to "To file", and file them as documents
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDocuments,
  getDocumentTypes,
  getDocumentFilterOptions,
  getExpiringDocuments,
  getInbox,
  uploadScans,
  discardScan,
  documentFileUrl,
  documentPageUrl,
} from '../utils/api';
import { exportDocumentsToExcel } from '../utils/exportUtils';
import { STATUS, TEXT_STATUS, daysUntil, fmtDay, fmtSize, groupOf, isReading, todayLocal } from '../utils/archive';
import { fmtDbTime } from '../utils/format';
import Toast from './Toast';
import DocumentForm from './DocumentForm';
import DocumentViewer from './DocumentViewer';

const PAGE_SIZE = 50;
// Columns with a ▾ filter, as on the asset list
const FILTER_FIELDS = { type: 'Type', year: 'Year', party: 'Company / From', department: 'Department', status: 'Status' };
const STATUS_VALUES = ['active', 'expiring', 'expired', 'none'];
const STATUS_NAMES = { active: 'Active', expiring: 'Expiring soon', expired: 'Expired', none: 'No end date' };
const EMPTY_FILTER = { type: [], year: [], party: [], department: [], status: [] };

export default function ArchiveView() {
  const [types, setTypes] = useState([]);
  const [options, setOptions] = useState({ types: [], years: [], parties: [], departments: [] });
  const [docs, setDocs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [expiringCount, setExpiringCount] = useState(0);
  const [allCount, setAllCount] = useState(0); // documents in the archive, before any search or filter

  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [showArchived, setShowArchived] = useState(false);
  const [dropdown, setDropdown] = useState({ field: null, open: false });
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef();
  const searchRef = useRef();

  const [inbox, setInbox] = useState([]);
  const [showInbox, setShowInbox] = useState(false);
  const [selected, setSelected] = useState([]); // scans ticked in "To file"
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef();
  const dragDepth = useRef(0);

  const [viewerId, setViewerId] = useState(null);
  const [form, setForm] = useState(null); // { mode: 'new', scanIds } | { mode: 'edit', doc }
  const [toast, setToast] = useState(null);
  const notify = (message, type = 'success') => setToast({ message, type });
  const closeToast = useCallback(() => setToast(null), []);

  /* ---- Loading ---- */
  const loadMeta = useCallback(async () => {
    try {
      const [t, o, exp, all] = await Promise.all([
        getDocumentTypes(),
        getDocumentFilterOptions({ includeArchived: showArchived }),
        getExpiringDocuments(todayLocal()),
        getDocuments({ page: 1, pageSize: 1, includeArchived: showArchived }),
      ]);
      setTypes(t || []);
      setOptions(o || { types: [], years: [], parties: [], departments: [] });
      setExpiringCount(exp?.expiring?.length || 0);
      setAllCount(all?.total || 0);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [showArchived]);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getDocuments({
        page, pageSize: PAGE_SIZE, search, ...filter, includeArchived: showArchived, today: todayLocal(),
      });
      setDocs(result.items || []);
      setTotal(result.total || 0);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, filter, showArchived]);

  const loadInbox = useCallback(async () => {
    try {
      const list = await getInbox();
      setInbox(list || []);
      setSelected((sel) => sel.filter((id) => (list || []).some((f) => f.id === id)));
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { loadDocs(); }, [loadDocs]);
  useEffect(() => { loadInbox(); }, [loadInbox]);

  // Search a moment after typing stops; filters and search start again at page 1
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchText]);
  useEffect(() => { setPage(1); }, [filter, showArchived]);

  // While scans are having their text read, refresh their state and the list every few seconds
  const inboxReading = inbox.some(isReading);
  const listReading = docs.some((d) => d.readingCount > 0);
  useEffect(() => {
    if (!inboxReading && !listReading) return undefined;
    const t = setInterval(() => {
      if (inboxReading) loadInbox();
      if (listReading) loadDocs();
    }, 5000);
    return () => clearInterval(t);
  }, [inboxReading, listReading, loadInbox, loadDocs]);

  // "/" jumps to the search box
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close the ▾ list on an outside click or Esc
  useEffect(() => {
    if (!dropdown.open) return undefined;
    const onDoc = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) closeDropdown(); };
    const onKey = (e) => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [dropdown.open]);

  const refreshAll = () => { loadDocs(); loadMeta(); loadInbox(); };

  /* ---- Column filters ---- */
  const valuesFor = (field) => {
    const known = field === 'type' ? options.types
      : field === 'year' ? options.years
      : field === 'party' ? options.parties
      : field === 'department' ? options.departments
      : STATUS_VALUES;
    return Array.from(new Set([...(known || []), ...filter[field]]));
  };
  const valueName = (field, v) => (field === 'status' ? STATUS_NAMES[v] || v : v);
  const toggleDropdown = (e, field) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setDropdown({ field, open: true });
    setDropdownPos({ top: rect.bottom, left: Math.min(rect.left, window.innerWidth - 260) });
  };
  const closeDropdown = () => setDropdown((d) => ({ ...d, open: false }));
  const toggleValue = (field, value) => setFilter((f) => ({
    ...f, [field]: f[field].includes(value) ? f[field].filter((v) => v !== value) : [...f[field], value],
  }));
  const clearAll = () => { setSearchText(''); setFilter(EMPTY_FILTER); };

  const chips = [];
  if (search) chips.push({ key: 'search', label: `Search: "${search}"`, remove: () => setSearchText('') });
  Object.keys(FILTER_FIELDS).forEach((field) => filter[field].forEach((v) => chips.push({
    key: `${field}:${v}`, label: `${FILTER_FIELDS[field]}: ${valueName(field, v)}`, remove: () => toggleValue(field, v),
  })));
  const filtering = chips.length > 0;

  const filterTh = (field, label, className = '') => {
    const n = filter[field].length;
    return (
      <th className={`ar-filter ${n ? 'on' : ''} ${className}`} onClick={(e) => toggleDropdown(e, field)} title={`Filter by ${label}`}>
        {label}{n ? ` (${n})` : ''} ▾
      </th>
    );
  };

  /* ---- Scans: upload, drop, discard ---- */
  const upload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    try {
      const added = await uploadScans(files);
      await loadInbox();
      setShowInbox(true);
      notify(`${added.length} scan${added.length === 1 ? '' : 's'} added to To file`);
    } catch (err) {
      notify(`Upload failed: ${err.message}`, 'error');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const onDragEnter = (e) => { if (!hasFiles(e) || form || viewerId) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); };
  const onDragOver = (e) => { if (hasFiles(e) && !form && !viewerId) e.preventDefault(); };
  const onDragLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
  const onDrop = (e) => {
    if (!hasFiles(e) || form || viewerId) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    upload(e.dataTransfer.files);
  };

  const discard = async (f) => {
    if (!window.confirm(`Discard "${f.originalName}" from To file?\n\nThe file is kept on the server, not deleted.`)) return;
    try {
      await discardScan(f.id);
      await loadInbox();
    } catch (err) {
      notify(`Couldn't discard: ${err.message}`, 'error');
    }
  };

  /* ---- Filing and editing ---- */
  const fileScans = (scanIds) => setForm({ mode: 'new', scanIds });

  const onSaved = async (id, { andNext } = {}) => {
    const wasEdit = form?.mode === 'edit';
    const filedIds = form?.scanIds || [];
    setForm(null);
    notify(wasEdit ? `${id} saved` : `Saved as ${id}`);
    setSelected([]);
    loadDocs();
    loadMeta();
    const list = await getInbox().catch(() => inbox);
    setInbox(list || []);
    if (wasEdit) setViewerId(id);
    if (andNext) {
      const next = (list || []).find((f) => !filedIds.includes(f.id));
      if (next) setForm({ mode: 'new', scanIds: [next.id] });
    }
  };

  const handleExport = async () => {
    try {
      const all = await getDocuments({ page: 0, search, ...filter, includeArchived: showArchived, today: todayLocal() });
      if (!all.length) { notify('No documents to export', 'error'); return; }
      exportDocumentsToExcel(all);
    } catch (err) {
      notify(`Export failed: ${err.message}`, 'error');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dropdownValues = dropdown.open ? valuesFor(dropdown.field) : [];

  return (
    <div className="ar" style={{ padding: 20 }} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging && <div className="ar-drop">Drop scans here to add them to To file</div>}

      {/* Banner */}
      <div className="ar-banner">
        <div>
          <h2>Document Archive</h2>
          <p>Scanned invoices, contracts, licenses, letters and memos. Search finds words inside the scans too.</p>
        </div>
        <div className="ar-stats">
          <button type="button" className="ar-stat" onClick={clearAll} title="Show all documents">
            <b>{allCount}</b>Documents
          </button>
          <button type="button" className="ar-stat" onClick={() => setShowInbox((v) => !v)} title="Scans waiting to be filed">
            <b>{inbox.length}</b>To file
          </button>
          <button type="button" className="ar-stat" onClick={() => { setSearchText(''); setFilter({ ...EMPTY_FILTER, status: ['expiring'] }); }} title="Ending in the next 90 days">
            <b>{expiringCount}</b>Expiring soon
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="ar-toolbar">
        <div className="ar-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search everything: subject, reference, company, ID, words inside the scans…  (press / )"
            aria-label="Search the archive"
          />
        </div>
        <button className="ar-btn ar-btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload Scans'}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          style={{ display: 'none' }}
          onChange={(e) => upload(e.target.files)}
        />
        <button className={`ar-btn ${inbox.length ? 'ar-btn-amber' : 'ar-btn-light'}`} onClick={() => setShowInbox((v) => !v)}>
          To File {inbox.length > 0 && <span className="ar-pill-count">{inbox.length}</span>}
        </button>
        <button className="ar-btn ar-btn-light" onClick={() => setForm({ mode: 'new', scanIds: [] })}>New Document</button>
        <button className="ar-btn ar-btn-export" onClick={handleExport}>Export to Excel</button>
        <label className="ar-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {loadError && <div className="ar-error">Couldn't load the archive: {loadError}</div>}

      {/* To file */}
      {showInbox && (
        <div className="ar-inbox">
          <div className="ar-inbox-head">
            <h3>To file · {inbox.length} scan{inbox.length === 1 ? '' : 's'} waiting</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {selected.length > 0 && (
                <button className="ar-btn ar-btn-primary ar-btn-sm" onClick={() => fileScans(selected)}>
                  File {selected.length} selected as one document
                </button>
              )}
              {inbox.length > 1 && (
                <button className="ar-btn ar-btn-light ar-btn-sm" onClick={() => setSelected(selected.length === inbox.length ? [] : inbox.map((f) => f.id))}>
                  {selected.length === inbox.length ? 'Clear selection' : 'Select all'}
                </button>
              )}
              <button className="ar-btn ar-btn-light ar-btn-sm" onClick={() => setShowInbox(false)}>Hide</button>
            </div>
          </div>
          {inbox.length === 0 ? (
            <div style={{ color: '#6b7280', fontSize: 14 }}>
              Nothing to file. Use <b>Upload Scans</b>, or drag scans from your computer onto this page.
            </div>
          ) : (
            <div className="ar-inbox-grid">
              {inbox.map((f) => {
                const isSel = selected.includes(f.id);
                const st = TEXT_STATUS[f.textStatus] || TEXT_STATUS.pending;
                return (
                  <div key={f.id} className={`ar-scan-card ${isSel ? 'selected' : ''}`}>
                    <div className="ar-thumb">
                      <img src={f.mimeType === 'application/pdf' ? documentPageUrl(f.id, 1, 300) : documentFileUrl(f.id)} alt="" loading="lazy" />
                    </div>
                    <label className="ar-check" style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={isSel} onChange={() => setSelected((s) => (isSel ? s.filter((x) => x !== f.id) : [...s, f.id]))} />
                      <span className="ar-filename">{f.originalName}</span>
                    </label>
                    <div className="ar-sub">{fmtSize(f.size)} · {fmtDbTime(f.uploadedAt)}</div>
                    <div style={{ fontSize: 12, color: st.color }}>{st.label}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="ar-btn ar-btn-primary ar-btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => fileScans([f.id])}>File it</button>
                      <button className="ar-btn ar-btn-danger ar-btn-sm" onClick={() => discard(f)}>Discard</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Filtering by */}
      {filtering && (
        <div style={activeBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 'bold', color: '#555' }}>Filtering by:</span>
          {chips.map((c) => (
            <span key={c.key} style={chipStyle}>
              {c.label}
              <button onClick={c.remove} style={chipRemoveStyle} aria-label={`Remove ${c.label}`} title="Remove this filter">×</button>
            </span>
          ))}
          <button onClick={clearAll} style={clearAllBtnStyle}>Clear all</button>
        </div>
      )}

      <div style={{ marginBottom: 12, fontSize: 14, color: '#555' }}>
        {loading ? 'Loading…'
          : filtering ? (total === 0 ? 'No documents match your search/filters.' : `${total} result${total === 1 ? '' : 's'} found`)
          : `${total} document${total === 1 ? '' : 's'} total`}
      </div>

      {/* The list */}
      <div className="ar-table-wrap">
        <table className="ar-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Subject</th>
              {filterTh('type', 'Type')}
              {filterTh('year', 'Date')}
              {filterTh('party', 'Company / From')}
              {filterTh('department', 'Department', 'ar-col-dept')}
              {filterTh('status', 'Status')}
              <th className="ar-col-scans">Scans</th>
            </tr>
          </thead>
          <tbody>
            {!loading && docs.length === 0 && (
              <tr>
                <td colSpan={8} className="ar-empty">
                  {filtering ? (
                    <>
                      <div>No documents match your current search/filters.</div>
                      <button onClick={clearAll} style={{ ...clearAllBtnStyle, marginTop: 10 }}>Clear search &amp; filters</button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 4 }}>The archive is empty</div>
                      <div>Scan your papers, then use <b>Upload Scans</b> or drag the files onto this page to start filing them.</div>
                    </>
                  )}
                </td>
              </tr>
            )}
            {docs.map((d) => {
              const group = groupOf(d.type, types);
              const status = STATUS[d.status];
              const days = d.status === 'expiring' ? daysUntil(d.endDate) : null;
              return (
                <tr key={d.id} className={`ar-row ${d.archived ? 'ar-archived' : ''}`} onClick={() => setViewerId(d.id)}>
                  <td className="ar-id">{d.id}</td>
                  <td className="ar-col-subject">
                    <div className="ar-subject" dir="auto">{d.subject}</div>
                    {(d.referenceNo || d.assetIds) && (
                      <div className="ar-sub">
                        {[d.referenceNo && `Ref. ${d.referenceNo}`, d.assetIds && `Assets: ${d.assetIds}`].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {d.snippet && (
                      <div className="ar-snippet" dir="auto">
                        {d.snippet.before}<mark>{d.snippet.match}</mark>{d.snippet.after}
                      </div>
                    )}
                  </td>
                  <td><span className={`ar-badge ar-group-${group}`}>{d.type}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(d.docDate)}</td>
                  <td>{d.party || <span className="ar-muted">—</span>}</td>
                  <td className="ar-col-dept">{d.department || <span className="ar-muted">—</span>}</td>
                  <td>
                    {d.archived ? <span className="ar-badge ar-group-Other">Archived</span>
                      : status ? (
                        <span className={`ar-badge ${status.cls}`} title={d.endDate ? `Ends ${fmtDay(d.endDate)}` : ''}>
                          {d.status === 'expiring' && days !== null ? `Expires in ${days} d` : status.label}
                        </span>
                      ) : <span className="ar-muted">—</span>}
                  </td>
                  <td className="ar-col-scans" style={{ whiteSpace: 'nowrap' }}>
                    {d.fileCount || <span className="ar-muted">0</span>}
                    {d.readingCount > 0 && <div className="ar-reading">reading text…</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="ar-pager">
          <button className="ar-btn ar-btn-light ar-btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>← Prev</button>
          <span>Page {page} of {totalPages} · {total} documents</span>
          <button className="ar-btn ar-btn-light ar-btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next →</button>
        </div>
      )}

      {/* The ▾ filter list for the column header that was clicked */}
      {dropdown.open && (
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, zIndex: 1000, minWidth: 180,
            maxHeight: 320, overflowY: 'auto', padding: 10, background: '#fff', border: '1px solid #ccc',
            borderRadius: 5, boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
          }}
        >
          {dropdownValues.length === 0 && <div style={{ fontSize: 12, color: '#999', padding: '4px 0' }}>No values available</div>}
          {dropdownValues.map((v) => (
            <div key={v} style={{ marginBottom: 8 }}>
              <label style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={filter[dropdown.field].includes(v)} onChange={() => toggleValue(dropdown.field, v)} style={{ marginRight: 6 }} />
                {valueName(dropdown.field, v)}
              </label>
            </div>
          ))}
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <button onClick={() => setFilter((f) => ({ ...f, [dropdown.field]: [] }))} style={{ fontSize: 12, color: '#007bff', border: 'none', background: 'transparent', cursor: 'pointer' }}>Clear Filter</button>
            <button onClick={closeDropdown} style={{ fontSize: 12, marginLeft: 10, color: '#28a745', border: 'none', background: 'transparent', cursor: 'pointer' }}>OK</button>
          </div>
        </div>
      )}

      {viewerId && (
        <DocumentViewer
          id={viewerId}
          types={types}
          onClose={() => setViewerId(null)}
          onEdit={(doc) => { setViewerId(null); setForm({ mode: 'edit', doc }); }}
          onChanged={refreshAll}
        />
      )}

      {form && (
        <DocumentForm
          key={form.mode === 'edit' ? form.doc.id : `new-${(form.scanIds || []).join('-')}`}
          mode={form.mode}
          doc={form.doc}
          scanIds={form.scanIds}
          inbox={inbox}
          types={types}
          parties={options.parties}
          hasNext={form.mode === 'new' && inbox.some((f) => !(form.scanIds || []).includes(f.id))}
          onClose={() => setForm(null)}
          onSaved={onSaved}
          onInboxChange={loadInbox}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={closeToast} />}
    </div>
  );
}

// "Filtering by:" bar and chips — the same look as the asset list
const activeBarStyle = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 10px', background: '#eef4ff', border: '1px solid #cfe0ff', borderRadius: 6 };
const chipStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #b6d0ff', borderRadius: 999, padding: '4px 10px', fontSize: 13, color: '#1d4ed8' };
const chipRemoveStyle = { border: 'none', background: 'transparent', color: '#1d4ed8', cursor: 'pointer', fontWeight: 'bold', fontSize: 14, lineHeight: 1, padding: 0 };
const clearAllBtnStyle = { fontSize: 13, color: '#dc3545', border: '1px solid #dc3545', background: '#fff', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' };
