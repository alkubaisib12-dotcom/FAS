// src/utils/exportUtils.js
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { API_URL } from './api';

/* ========= Helpers ========= */

// Sanitize Excel sheet names: remove invalid chars and cap at 31 chars
const safeSheetName = (name) => {
  const base = (name || 'Sheet').toString().trim() || 'Sheet';
  return base.replace(/[:\\/?*\[\]]/g, ' ').slice(0, 31);
};

// Turn relative "/uploads/..." into absolute "http(s)://host:4000/uploads/..."
const resolveUrl = (u) => (u && u.startsWith('/') ? `${API_URL}${u}` : u || '');

// Safe filename inside ZIP
const safeFile = (s, ext = '') =>
  (`${String(s || 'UNKNOWN')}`.replace(/[^A-Za-z0-9._-]/g, '_') + ext).replace(/_+/g, '_');

// Split brandModel using the same “first space” heuristic used in the table
const splitBrandModel = (bm = '') => {
  const s = String(bm || '').trim();
  if (!s) return { brand: '', model: '' };
  const idx = s.indexOf(' ');
  if (idx === -1) return { brand: s, model: '' };
  return { brand: s.slice(0, idx).trim(), model: s.slice(idx + 1).trim() };
};

/* ========= Excel sheet builder with invoice hyperlink column ========= */

function makeSheetWithInvoice(rows) {
  // Normalize each row into friendly column headers and ensure Brand/Model are separate
  const data = (rows || []).map((r) => {
    const derived = splitBrandModel(r?.brandModel);
    const brand = (r?.brand ?? derived.brand) || '';
    const model = (r?.model ?? derived.model) || '';

    const out = {
      'Asset ID': r?.assetId || '',
      'Group': r?.group || '',
      'Asset Type': r?.assetType || '',
      'Brand': brand,
      'Model': model,
      'Serial Number': r?.serialNumber || '',
      'Assigned To': r?.assignedTo || '',
      'IP Address': r?.ipAddress || '',
      'MAC Address': r?.macAddress || '',
      'OS/Firmware': r?.osFirmware || '',
      'CPU': r?.cpu || '',
      'RAM (GB)': r?.ram || '',
      'Storage (GB)': r?.storage || '',
      'Port Details': r?.portDetails || '',
      'Power Consumption': r?.powerConsumption || '',
      'Purchase Date': r?.purchaseDate || '',
      'Warranty Expiry': r?.warrantyExpiry || '',
      'EOL': r?.eol || '',
      'Maintenance Expiry': r?.maintenanceExpiry || '',
      'Cost': r?.cost || '',
      'Depreciation': r?.depreciation || '',
      'Residual Value': r?.residualValue || '',
      'Status': r?.status || '',
      'Condition': r?.condition || '',
      'Usage Purpose': r?.usagePurpose || '',
      'Access Level': r?.accessLevel || '',
      'License Key': r?.licenseKey || '',
      'Compliance Status': r?.complianceStatus || '',
      'Documentation': r?.documentation || '',
      'Remarks': r?.remarks || '',
      'Last Audit Date': r?.lastAuditDate || '',
      'Disposed Date': r?.disposedDate || '',
      'Replacement Plan': r?.replacementPlan || '',
      // Friendly link column; actual hyperlink set below
      'Invoice PDF': r?.invoiceUrl ? 'View' : '',
      // Keep invoiceUrl off the sheet (not a visible column)
    };
    return out;
  });

  const ws = XLSX.utils.json_to_sheet(data);

  // Find "Invoice PDF" header column index
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  let invoiceColIdx = -1;

  for (let C = range.s.c; C <= range.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: range.s.r, c: C });
    const cell = ws[addr];
    if (cell && cell.v === 'Invoice PDF') {
      invoiceColIdx = C;
      break;
    }
  }

  if (invoiceColIdx >= 0) {
    // Convert data row cells to hyperlinks
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: invoiceColIdx });
      const cell = ws[addr];
      const original = rows[R - 1];
      const url = original?.invoiceUrl ? resolveUrl(original.invoiceUrl) : '';

      if (url) {
        ws[addr] = { t: 's', v: 'View', l: { Target: url } };
      } else if (cell) {
        cell.t = 's';
        cell.v = '';
      } else {
        ws[addr] = { t: 's', v: '' };
      }
    }
  }

  return ws;
}

/* ========= Plain Excel exports (kept for compatibility) ========= */

export function exportToExcel(data, fileName = 'assets.xlsx') {
  const book = XLSX.utils.book_new();
  const sheet = makeSheetWithInvoice(Array.isArray(data) ? data : []);
  XLSX.utils.book_append_sheet(book, sheet, safeSheetName('All Assets'));
  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buffer]), fileName);
}

export function exportToExcelByGroup(data, fileName = 'grouped_assets.xlsx') {
  const rows = Array.isArray(data) ? data : [];
  const book = XLSX.utils.book_new();

  const groups = [...new Set(rows.map(a => a.group).filter(Boolean))];

  groups.forEach((group) => {
    const filtered = rows.filter(a => a.group === group);
    const sheet = makeSheetWithInvoice(filtered);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName(group));
  });

  const ungrouped = rows.filter(a => !a.group);
  if (ungrouped.length > 0) {
    const sheet = makeSheetWithInvoice(ungrouped);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName('Ungrouped'));
  }

  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buffer]), fileName);
}

export function exportGroupOnly(data, group, fileName = 'group_assets.xlsx') {
  const rows = Array.isArray(data) ? data : [];
  const filtered = rows.filter(a => a.group === group);
  exportToExcel(filtered, fileName);
}

/* ========= SMART EXPORT (ZIP when invoices exist) ========= */

// Build an Excel workbook (without saving) and return ArrayBuffer (single-sheet)
async function buildWorkbookBuffer(rows, sheetName = 'All Assets') {
  const book = XLSX.utils.book_new();
  const sheet = makeSheetWithInvoice(Array.isArray(rows) ? rows : []);
  XLSX.utils.book_append_sheet(book, sheet, safeSheetName(sheetName));
  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  return buffer;
}

// Build an Excel workbook (without saving) with separate sheets by group
async function buildGroupedWorkbookBuffer(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const book = XLSX.utils.book_new();

  const groups = [...new Set(list.map(a => a.group).filter(Boolean))];
  groups.forEach((g) => {
    const filtered = list.filter(a => a.group === g);
    const sheet = makeSheetWithInvoice(filtered);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName(g));
  });

  const ungrouped = list.filter(a => !a.group);
  if (ungrouped.length > 0) {
    const sheet = makeSheetWithInvoice(ungrouped);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName('Ungrouped'));
  }

  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  return buffer;
}

// Fetch a URL as Blob (gracefully continue on failure)
async function fetchAsBlob(url) {
  try {
    // uploads are served publicly; cookies not required
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * If any asset has invoiceUrl → ZIP { assets.xlsx, invoices/*.pdf }
 * Else → just assets.xlsx
 */
export async function exportWithInvoicesIfAny(rows, {
  excelName = 'assets.xlsx',
  zipName = 'assets_export.zip',
  invoicesDirName = 'invoices'
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const withInvoices = list
    .map((a, idx) => ({ a, idx, url: a?.invoiceUrl ? resolveUrl(a.invoiceUrl) : '' }))
    .filter(x => !!x.url);

  // If nothing to download, just export Excel (single-sheet)
  if (withInvoices.length === 0) {
    return exportToExcel(list, excelName);
  }

  // Build Excel buffer (single-sheet)
  const excelBuf = await buildWorkbookBuffer(list, 'All Assets');

  // Prepare ZIP
  const zip = new JSZip();
  zip.file(excelName, excelBuf);
  const folder = zip.folder(invoicesDirName);

  // Download PDFs in parallel
  const blobs = await Promise.allSettled(withInvoices.map(x => fetchAsBlob(x.url)));

  blobs.forEach((res, i) => {
    const { a } = withInvoices[i];
    const blob = res.status === 'fulfilled' ? res.value : null;
    if (!blob) return; // skip failed downloads
    const name = safeFile(a.assetId || `INV-${i + 1}`, '.pdf');
    folder.file(name, blob);
  });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  saveAs(zipBlob, zipName);
}

/**
 * If any asset has invoiceUrl → ZIP { assets.xlsx (separate sheets by group), invoices/*.pdf }
 * Else → just assets.xlsx with separate sheets by group
 */
export async function exportByGroupWithInvoicesIfAny(rows, {
  excelName = 'assets_by_group.xlsx',
  zipName = 'assets_by_group.zip',
  invoicesDirName = 'invoices'
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const withInvoices = list
    .map((a, idx) => ({ a, idx, url: a?.invoiceUrl ? resolveUrl(a.invoiceUrl) : '' }))
    .filter(x => !!x.url);

  // Build grouped Excel buffer (multiple sheets)
  const excelBuf = await buildGroupedWorkbookBuffer(list);

  if (withInvoices.length === 0) {
    // No invoices → just save the grouped workbook
    saveAs(new Blob([excelBuf]), excelName);
    return;
  }

  // ZIP with invoices
  const zip = new JSZip();
  zip.file(excelName, excelBuf);
  const folder = zip.folder(invoicesDirName)
  const blobs = await Promise.allSettled(withInvoices.map(x => fetchAsBlob(x.url)));
  blobs.forEach((res, i) => {
    const { a } = withInvoices[i];
    const blob = res.status === 'fulfilled' ? res.value : null;
    if (!blob) return;
    const name = safeFile(a.assetId || `INV-${i + 1}`, '.pdf');
    folder.file(name, blob);
  });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  saveAs(zipBlob, zipName);
}

/* ========= CONSUMABLES EXPORT ========= */

// Build consumables sheet with dynamic custom fields
function makeConsumablesSheet(rows, customFields = []) {
  const data = (rows || []).map((r) => {
    const base = {
      'ID': r?.id || '',
      'Name': r?.name || '',
      'Quantity': r?.quantity || 0,
      'Company': r?.company || '',
    };

    // Add custom fields dynamically
    const custom = r?.customFields || {};
    customFields.forEach(field => {
      base[field.fieldName] = custom[field.fieldName] || '';
    });

    base['Created At'] = r?.createdAt || '';
    base['Updated At'] = r?.updatedAt || '';

    return base;
  });

  return XLSX.utils.json_to_sheet(data);
}

// Export consumables to Excel (standalone)
export function exportConsumablesToExcel(consumables, customFields = [], fileName = 'consumables.xlsx') {
  const book = XLSX.utils.book_new();
  const sheet = makeConsumablesSheet(consumables, customFields);
  XLSX.utils.book_append_sheet(book, sheet, safeSheetName('Consumables'));
  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buffer]), fileName);
}

// Build combined workbook with assets and consumables sheets
async function buildCombinedWorkbookBuffer(assetRows, consumableRows, customFields, grouped = false) {
  const book = XLSX.utils.book_new();

  if (grouped) {
    // Assets by group (multiple sheets)
    const list = Array.isArray(assetRows) ? assetRows : [];
    const groups = [...new Set(list.map(a => a.group).filter(Boolean))];

    groups.forEach((g) => {
      const filtered = list.filter(a => a.group === g);
      const sheet = makeSheetWithInvoice(filtered);
      XLSX.utils.book_append_sheet(book, sheet, safeSheetName(g));
    });

    const ungrouped = list.filter(a => !a.group);
    if (ungrouped.length > 0) {
      const sheet = makeSheetWithInvoice(ungrouped);
      XLSX.utils.book_append_sheet(book, sheet, safeSheetName('Ungrouped'));
    }
  } else {
    // Assets (single sheet)
    const assetsSheet = makeSheetWithInvoice(assetRows);
    XLSX.utils.book_append_sheet(book, assetsSheet, safeSheetName('Assets'));
  }

  // Consumables sheet
  const consumablesSheet = makeConsumablesSheet(consumableRows, customFields);
  XLSX.utils.book_append_sheet(book, consumablesSheet, safeSheetName('Consumables'));

  return XLSX.write(book, { bookType: 'xlsx', type: 'array' });
}

/**
 * Export with optional consumables sheet
 * If includeConsumables is true, adds consumables as a separate sheet
 */
export async function exportWithConsumablesIfAny(assetRows, {
  excelName = 'assets.xlsx',
  zipName = 'assets_export.zip',
  invoicesDirName = 'invoices',
  consumables = null,
  customFields = [],
  grouped = false
} = {}) {
  const list = Array.isArray(assetRows) ? assetRows : [];
  const withInvoices = list
    .map((a, idx) => ({ a, idx, url: a?.invoiceUrl ? resolveUrl(a.invoiceUrl) : '' }))
    .filter(x => !!x.url);

  // Determine if we need a combined workbook
  const needsCombined = consumables && Array.isArray(consumables) && consumables.length > 0;

  let excelBuf;
  if (needsCombined) {
    // Build combined workbook with both assets and consumables
    excelBuf = await buildCombinedWorkbookBuffer(list, consumables, customFields, grouped);
  } else {
    // Just assets
    if (grouped) {
      excelBuf = await buildGroupedWorkbookBuffer(list);
    } else {
      excelBuf = await buildWorkbookBuffer(list, 'Assets');
    }
  }

  // If no invoices, just save Excel
  if (withInvoices.length === 0) {
    saveAs(new Blob([excelBuf]), excelName);
    return;
  }

  // Build ZIP with Excel + invoices
  const zip = new JSZip();
  zip.file(excelName, excelBuf);
  const folder = zip.folder(invoicesDirName);

  const blobs = await Promise.allSettled(withInvoices.map(x => fetchAsBlob(x.url)));
  blobs.forEach((res, i) => {
    const { a } = withInvoices[i];
    const blob = res.status === 'fulfilled' ? res.value : null;
    if (!blob) return;
    const name = safeFile(a.assetId || `INV-${i + 1}`, '.pdf');
    folder.file(name, blob);
  });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  saveAs(zipBlob, zipName);
}
