// src/utils/archive.js — shared helpers for the document archive screens

// What each document group asks for, beyond subject, date, reference and department
export const GROUP_FIELDS = {
  Purchase: { amount: true, dates: false },
  Contracts: { amount: true, dates: true },
  Correspondence: { amount: false, dates: false },
  Other: { amount: true, dates: true },
};

export const groupOf = (type, types) => (types || []).find((t) => t.name === type)?.group || 'Other';

// The name of the "party" field for a type: who sent, received, sold or signed it
export function partyLabel(type, group) {
  if (type === 'Incoming Letter') return 'From';
  if (type === 'Outgoing Letter') return 'To';
  if (type === 'Memo') return 'From / To';
  if (group === 'Purchase') return 'Supplier';
  if (group === 'Contracts') return 'Company';
  return 'Company / person';
}

export const STATUS = {
  active: { label: 'Active', cls: 'ar-status-active' },
  expiring: { label: 'Expiring soon', cls: 'ar-status-expiring' },
  expired: { label: 'Expired', cls: 'ar-status-expired' },
};

// Today as YYYY-MM-DD in local time
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "15 Mar 2026" from "2026-03-15"
export function fmtDay(ymd) {
  if (!ymd) return '—';
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Whole days from today to a YYYY-MM-DD date (negative when past)
export function daysUntil(ymd) {
  if (!ymd) return null;
  const a = new Date(`${ymd}T00:00:00`);
  const b = new Date(`${todayLocal()}T00:00:00`);
  return Math.round((a - b) / 86400000);
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtAmount(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const decimals = (currency || 'BHD') === 'BHD' ? 3 : 2;
  return `${currency || 'BHD'} ${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// What the text reading of a scan says, for showing next to it
export const TEXT_STATUS = {
  pending: { label: 'Waiting to read text…', color: '#b45309' },
  reading: { label: 'Reading text…', color: '#b45309' },
  done: { label: 'Text read', color: '#166534' },
  none: { label: 'No text found', color: '#6b7280' },
  failed: { label: "Couldn't read text", color: '#b91c1c' },
};

export const isReading = (f) => f && (f.textStatus === 'pending' || f.textStatus === 'reading');
