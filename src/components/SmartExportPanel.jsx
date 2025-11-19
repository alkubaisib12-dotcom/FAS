// src/components/SmartExportPanel.jsx
import React, { useState, useMemo } from 'react';
import { exportWithInvoicesIfAny, exportByGroupWithInvoicesIfAny } from '../utils/exportUtils';

export default function SmartExportPanel({ assets }) {
  const [mode, setMode] = useState('all'); // 'all' | 'byGroup' | 'singleGroup'
  const [group, setGroup] = useState('');
  const [fileName, setFileName] = useState('assets_export.xlsx');

  // Current selection based on mode/group
  const selectedAssets = useMemo(() => {
    const raw = Array.isArray(assets) ? assets : [];
    if (mode === 'singleGroup') {
      return group ? raw.filter(a => a.group === group) : [];
    }
    // 'all' and 'byGroup' export the full set; grouping is handled downstream
    return raw;
  }, [assets, mode, group]);

  // Group options from all assets (not just selection)
  const allGroups = useMemo(
    () => Array.from(new Set((assets || []).map(a => a.group).filter(Boolean))),
    [assets]
  );

  // --- Split helper (kept simple and consistent with table logic) ---
  const splitBrandModel = (bm = '') => {
    const s = String(bm || '').trim();
    if (!s) return { brand: '', model: '' };
    const idx = s.indexOf(' ');
    if (idx === -1) return { brand: s, model: '' };
    return { brand: s.slice(0, idx).trim(), model: s.slice(idx + 1).trim() };
  };

  // --- Prepare assets passed to exporter: inject brand/model while preserving brandModel ---
  const assetsPrepared = useMemo(() => {
    return selectedAssets.map(a => {
      const derived = splitBrandModel(a.brandModel);
      return {
        ...a,
        brand: (a.brand ?? derived.brand) || '',
        model: (a.model ?? derived.model) || '',
      };
    });
  }, [selectedAssets]);

  // Optional normalization (kept for potential preview UIs)
  const normalized = useMemo(() => {
    return selectedAssets.map(a => {
      const derived = splitBrandModel(a.brandModel);
      const brand = (a.brand ?? derived.brand) || '';
      const model = (a.model ?? derived.model) || '';
      return {
        'Asset ID': a.assetId || '',
        'Group': a.group || '',
        'Asset Type': a.assetType || '',
        'Brand': brand,
        'Model': model,
        'Serial Number': a.serialNumber || '',
        'Assigned To': a.assignedTo || '',
        'IP Address': a.ipAddress || '',
        'MAC Address': a.macAddress || '',
        'OS/Firmware': a.osFirmware || '',
        'CPU': a.cpu || '',
        'RAM (GB)': a.ram || '',
        'Storage (GB)': a.storage || '',
        'Port Details': a.portDetails || '',
        'Power Consumption': a.powerConsumption || '',
        'Purchase Date': a.purchaseDate || '',
        'Warranty Expiry': a.warrantyExpiry || '',
        'EOL': a.eol || '',
        'Maintenance Expiry': a.maintenanceExpiry || '',
        'Cost': a.cost || '',
        'Depreciation': a.depreciation || '',
        'Residual Value': a.residualValue || '',
        'Status': a.status || '',
        'Condition': a.condition || '',
        'Usage Purpose': a.usagePurpose || '',
        'Access Level': a.accessLevel || '',
        'License Key': a.licenseKey || '',
        'Compliance Status': a.complianceStatus || '',
        'Documentation': a.documentation || '',
        'Remarks': a.remarks || '',
        'Last Audit Date': a.lastAuditDate || '',
        'Disposed Date': a.disposedDate || '',
        'Replacement Plan': a.replacementPlan || ''
      };
    });
  }, [selectedAssets]);

  const ensureXlsx = (name) => {
    const base = String(name || 'assets_export.xlsx').trim() || 'assets_export.xlsx';
    return /\.xlsx$/i.test(base) ? base : `${base.replace(/\.[^.]+$/g, '')}.xlsx`;
  };

  const zipNameFromXlsx = (xlsx) => xlsx.replace(/\.xlsx$/i, '') + '.zip';

  const handleExport = async () => {
    if (assetsPrepared.length === 0) {
      if (mode === 'singleGroup' && !group) {
        alert('Select a group first.');
        return;
      }
      alert('No assets to export.');
      return;
    }

    // Choose filename defaults per mode
    const defaultName =
      mode === 'byGroup'
        ? 'assets_by_group.xlsx'
        : mode === 'singleGroup' && group
        ? `${group}_assets.xlsx`
        : 'assets_export.xlsx';

    const excelName = ensureXlsx(fileName || defaultName);
    const zipName = zipNameFromXlsx(excelName);

    if (mode === 'byGroup') {
      await exportByGroupWithInvoicesIfAny(assetsPrepared, {
        excelName,
        zipName,
        invoicesDirName: 'invoices'
      });
    } else {
      await exportWithInvoicesIfAny(assetsPrepared, {
        excelName,
        zipName,
        invoicesDirName: 'invoices'
      });
    }
  };

  return (
    <div style={container}>
      <div style={field}>
        <label style={label}>Export Mode</label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={select}>
          <option value="all">All assets (1 sheet)</option>
          <option value="byGroup">All assets (separate sheets by group)</option>
          <option value="singleGroup">Specific group only</option>
        </select>
      </div>

      {mode === 'singleGroup' && (
        <div style={field}>
          <label style={label}>Choose Group</label>
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={select}>
            <option value="">-- Select --</option>
            {allGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
      )}

      <div style={field}>
        <label style={label}>File Name</label>
        <input
          type="text"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          style={input}
          placeholder="e.g. assets_export.xlsx"
        />
        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          If any invoice exists, a ZIP will be downloaded instead (containing this Excel and an <code>invoices/</code> folder).
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: '20px' }}>
        <button onClick={handleExport} style={button}>Export Now</button>
      </div>

      {/* Count now reflects the current mode/group selection */}
      <div style={{ marginTop: 14, textAlign: 'center', color: '#6b7280', fontSize: 12 }}>
        Assets selected: {selectedAssets.length}
      </div>
    </div>
  );
}

/* === Styles === */
const container = {
  background: '#ffffff',
  padding: '20px',
  borderRadius: '10px',
  border: '1px solid #ddd',
  maxWidth: '600px',
  margin: '0 auto 30px auto',
  boxShadow: '0 0 12px rgba(0,0,0,0.06)'
};
const field = { marginBottom: '16px' };
const label = { display: 'block', marginBottom: '6px', fontWeight: 'bold', color: '#444' };
const input = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ccc',
  borderRadius: '6px',
  fontSize: '14px'
};
const select = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ccc',
  borderRadius: '6px',
  fontSize: '14px',
  background: '#fff'
};
const button = {
  backgroundColor: '#007bff',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  padding: '10px 20px',
  fontSize: '16px',
  cursor: 'pointer'
};
