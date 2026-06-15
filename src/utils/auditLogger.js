import { API_URL } from './api';

async function auditRequest(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, { credentials: 'include', ...options });
  if (!res.ok) throw new Error(`Audit log request failed: ${res.status}`);
  return res.json();
}

export function getAuditLog({ limit = 100, entityType } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (entityType) params.set('entity_type', entityType);
  return auditRequest(`/audit-log?${params}`);
}
