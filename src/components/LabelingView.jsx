// src/components/LabelingView.jsx
//
// Tracks which assets already have their physical tag printed and attached.
// This view is intentionally read-only for every field except the "Labeled"
// checkbox — Asset IDs (the tag values) are displayed but can never be
// edited or changed from here.
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { getAllAssets, setAssetLabeled, getLabelStats } from '../utils/api';

const PAGE_SIZE = 100;

export default function LabelingView() {
  const [assets, setAssets]   = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(false);

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(false);

  const [stats, setStats] = useState(null); // { total, labeled, unlabeled }
  const [togglingId, setTogglingId] = useState(null);

  const debounceTimer = useRef(null);

  // Debounce search text
  useEffect(() => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchText);
      setPage(1);
    }, 400);
    return () => clearTimeout(debounceTimer.current);
  }, [searchText]);

  // Reset page when the unlabeled-only filter changes
  useEffect(() => { setPage(1); }, [onlyUnlabeled]);

  const loadAssets = useCallback(async (p) => {
    setLoading(true);
    try {
      const result = await getAllAssets({
        page: p,
        pageSize: PAGE_SIZE,
        search: debouncedSearch,
        labeled: onlyUnlabeled ? false : undefined,
      });
      setAssets(result.items ?? result);
      setTotal(result.total ?? (Array.isArray(result) ? result.length : 0));
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [debouncedSearch, onlyUnlabeled]);

  useEffect(() => { loadAssets(page); }, [page, loadAssets]);

  const loadStats = useCallback(async () => {
    try {
      const s = await getLabelStats();
      setStats(s);
    } catch (err) {
      console.error('Failed to load label stats', err);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const handleToggle = async (asset) => {
    const newVal = !asset.labeled;
    setTogglingId(asset.assetId);

    // Optimistic update so clicking through a list of assets feels instant.
    setAssets(prev => {
      const updated = prev.map(a => a.assetId === asset.assetId ? { ...a, labeled: newVal } : a);
      // If we're only showing unlabeled assets, a newly-labeled one drops out of view.
      return (onlyUnlabeled && newVal) ? updated.filter(a => a.assetId !== asset.assetId) : updated;
    });
    if (onlyUnlabeled && newVal) {
      setTotal(t => Math.max(0, t - 1));
    }
    setStats(prev => prev ? {
      ...prev,
      labeled: prev.labeled + (newVal ? 1 : -1),
      unlabeled: prev.unlabeled + (newVal ? -1 : 1),
    } : prev);

    try {
      await setAssetLabeled(asset.assetId, newVal);
    } catch (err) {
      console.error(err);
      alert('Failed to update label status: ' + err.message);
      // Re-sync with the server on failure
      loadAssets(page);
      loadStats();
    } finally {
      setTogglingId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const progressPct = stats && stats.total > 0 ? Math.round((stats.labeled / stats.total) * 100) : 0;

  return (
    <div style={{ padding: '20px', background: '#f9f9f9', borderRadius: '10px' }}>
      <h2 style={{ marginBottom: '10px', fontSize: '24px' }}>Asset Labeling</h2>

      <p style={{ marginTop: 0, marginBottom: '16px', color: '#555', fontSize: '14px' }}>
        Track which assets already have their physical tag printed and attached.
        Asset IDs below are the tag values themselves — they're shown for reference only and are never changed here.
      </p>

      {stats && (
        <div style={statBoxStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '14px' }}>
            <span><strong>{stats.labeled}</strong> of <strong>{stats.total}</strong> assets labeled</span>
            <span style={{ color: '#555' }}>{stats.unlabeled} remaining</span>
          </div>
          <div style={progressOuterStyle}>
            <div style={{ ...progressInnerStyle, width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by Asset ID, Serial, Brand…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ padding: '6px', width: '280px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px' }}>
          <input type="checkbox" checked={onlyUnlabeled} onChange={(e) => setOnlyUnlabeled(e.target.checked)} />
          Show only unlabeled
        </label>
      </div>

      {!loading && (
        <div style={{ marginBottom: '12px', fontSize: '14px', color: '#555' }}>
          {total} asset{total === 1 ? '' : 's'}{(debouncedSearch || onlyUnlabeled) ? ' match your search/filter' : ' total'}
        </div>
      )}

      {loading ? (
        <p style={{ fontStyle: 'italic', color: '#999' }}>Loading…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
            <thead style={{ background: '#e9ecef' }}>
              <tr>
                <th style={thStyle}>Asset ID (Tag)</th>
                <th style={thStyle}>Group</th>
                <th style={thStyle}>Asset Type</th>
                <th style={thStyle}>Brand</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Serial Number</th>
                <th style={thStyle}>Assigned To</th>
                <th style={thStyle}>Department</th>
                <th style={thStyle}>Labeled</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={9} style={emptyCellStyle}>
                    {onlyUnlabeled
                      ? 'Every asset matching your search is already labeled.'
                      : (debouncedSearch ? 'No assets match your search.' : 'No assets found.')}
                  </td>
                </tr>
              ) : assets.map((asset) => {
                const bm  = (asset.brandModel || '').trim();
                const idx = bm.indexOf(' ');
                const b   = idx > -1 ? bm.slice(0, idx).trim() : bm;
                const m   = idx > -1 ? bm.slice(idx + 1).trim() : '';
                const isLabeled = !!asset.labeled;
                return (
                  <tr key={asset.assetId} style={{ borderBottom: '1px solid #ddd' }}>
                    <td style={{ ...tdStyle, fontWeight: 'bold', fontFamily: 'monospace' }}>{asset.assetId}</td>
                    <td style={tdStyle}>{asset.group}</td>
                    <td style={tdStyle}>{asset.assetType}</td>
                    <td style={tdStyle}>{b || '-'}</td>
                    <td style={tdStyle}>{m || '-'}</td>
                    <td style={tdStyle}>{asset.serialNumber}</td>
                    <td style={tdStyle}>{asset.assignedTo}</td>
                    <td style={tdStyle}>{asset.department || '-'}</td>
                    <td style={tdStyle}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isLabeled}
                          disabled={togglingId === asset.assetId}
                          onChange={() => handleToggle(asset)}
                        />
                        <span style={{ color: isLabeled ? '#28a745' : '#999', fontWeight: isLabeled ? 'bold' : 'normal' }}>
                          {isLabeled ? 'Labeled' : 'Not labeled'}
                        </span>
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', fontSize: '14px' }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={pageBtnStyle}>← Prev</button>
            <span>Page {page} of {totalPages} &nbsp;·&nbsp; {total} total</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={pageBtnStyle}>Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle        = { padding: '10px', textAlign: 'left', fontWeight: 'bold', fontSize: '14px', borderBottom: '2px solid #ccc' };
const tdStyle        = { padding: '10px', fontSize: '14px', verticalAlign: 'top' };
const pageBtnStyle   = { padding: '4px 12px', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', background: '#fff' };
const emptyCellStyle = { padding: '30px', textAlign: 'center', fontStyle: 'italic', color: '#999' };
const statBoxStyle   = { marginBottom: '16px', padding: '12px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px' };
const progressOuterStyle = { width: '100%', height: '10px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' };
const progressInnerStyle = { height: '100%', background: '#28a745', transition: 'width 300ms ease' };
