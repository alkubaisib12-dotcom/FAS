import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

// Sanitize Excel sheet names: remove invalid chars and cap at 31 chars
const safeSheetName = (name) => {
  const base = (name || 'Sheet').toString().trim() || 'Sheet';
  return base.replace(/[:\\/?*\[\]]/g, ' ').slice(0, 31);
};

// Helper: read group from either raw model ('group') or normalized export ('Group')
const getGroup = (row) => row.group ?? row['Group'] ?? '';

export function exportToExcel(rows, fileName = 'assets.xlsx') {
  const sheet = XLSX.utils.json_to_sheet(rows || []);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, safeSheetName('All Assets'));
  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buffer]), fileName);
}

export function exportToExcelByGroup(rows, fileName = 'grouped_assets.xlsx') {
  const list = Array.isArray(rows) ? rows : [];
  const book = XLSX.utils.book_new();

  const groups = [...new Set(list.map(r => getGroup(r)).filter(Boolean))];

  groups.forEach((g) => {
    const filtered = list.filter(r => getGroup(r) === g);
    const sheet = XLSX.utils.json_to_sheet(filtered);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName(g));
  });

  const ungrouped = list.filter(r => !getGroup(r));
  if (ungrouped.length > 0) {
    const sheet = XLSX.utils.json_to_sheet(ungrouped);
    XLSX.utils.book_append_sheet(book, sheet, safeSheetName('Ungrouped'));
  }

  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buffer]), fileName);
}

export function exportGroupOnly(rows, group, fileName = 'group_assets.xlsx') {
  const list = Array.isArray(rows) ? rows : [];
  const filtered = list.filter(r => getGroup(r) === group);
  exportToExcel(filtered, fileName);
}
