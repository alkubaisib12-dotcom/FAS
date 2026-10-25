export function fmtBD(value) {
  const num = Number(value || 0);
  return `BD ${new Intl.NumberFormat('en-BH', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }).format(num)}`;
}

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" with no time zone, which
// browsers read as local time (3 hours early in Bahrain). Read it as UTC, show it as local.
export function fmtDbTime(value) {
  if (!value) return '-';
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const date = new Date(iso);
  return isNaN(date) ? s : date.toLocaleString();
}
