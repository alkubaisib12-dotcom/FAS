// src/components/DocumentViewer.jsx — one archived document: its scans beside its details
import React, { useCallback, useEffect, useState } from 'react';
import { getDocument, archiveDocument, restoreDocument, readScanTextAgain } from '../utils/api';
import { fmtDbTime } from '../utils/format';
import { GROUP_FIELDS, STATUS, TEXT_STATUS, daysUntil, fmtAmount, fmtDay, groupOf, isReading, partyLabel } from '../utils/archive';
import Modal from './Modal';
import ScanPreview from './ScanPreview';

export default function DocumentViewer({ id, types, onClose, onEdit, onChanged }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDoc(await getDocument(id));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // While a scan's text is being read, check again every few seconds
  const anyReading = (doc?.files || []).some(isReading);
  useEffect(() => {
    if (!anyReading) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyReading, load]);

  const toggleArchive = async () => {
    if (!doc.archived && !window.confirm(`Archive ${doc.id}?\n\nIt leaves the list but keeps its details and scans. You can restore it with "Show archived".`)) return;
    setBusy(true);
    try {
      if (doc.archived) await restoreDocument(doc.id); else await archiveDocument(doc.id);
      onChanged();
      if (doc.archived) await load(); else onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const readAgain = async (fileId) => {
    try {
      await readScanTextAgain(fileId);
      await load();
    } catch (err) { setError(err.message); }
  };

  if (!doc) {
    return (
      <Modal isOpen onClose={onClose} maxWidth={1200}>
        <div className="ar-empty">{error || 'Loading…'}</div>
      </Modal>
    );
  }

  const group = groupOf(doc.type, types);
  const fields = GROUP_FIELDS[group] || GROUP_FIELDS.Other;
  const status = STATUS[doc.status];
  const days = daysUntil(doc.endDate);
  const current = doc.files.find((f) => f.id === previewId) || doc.files[0];
  const textState = current && TEXT_STATUS[current.textStatus];

  const row = (label, value) => (value === null || value === undefined || value === '' ? null : (
    <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>
  ));

  return (
    <Modal isOpen onClose={onClose} maxWidth={1200}>
      <div className="ar">
        <div className="ar-head">
          <h3>{doc.id}</h3>
          <span className={`ar-badge ar-group-${group}`}>{doc.type}</span>
          {status && <span className={`ar-badge ${status.cls}`}>{status.label}</span>}
          {doc.archived && <span className="ar-badge ar-group-Other">Archived</span>}
          <span style={{ flex: 1 }} />
          {!doc.archived && <button className="ar-btn ar-btn-primary ar-btn-sm" onClick={() => onEdit(doc)}>Edit</button>}
          <button className={`ar-btn ar-btn-sm ${doc.archived ? 'ar-btn-light' : 'ar-btn-danger'}`} onClick={toggleArchive} disabled={busy}>
            {doc.archived ? 'Restore' : 'Archive'}
          </button>
        </div>
        {error && <div className="ar-error">{error}</div>}

        <div className="ar-dialog">
          <div>
            <ScanPreview files={doc.files} selectedId={previewId} onSelect={setPreviewId} emptyText="This document has no scan yet. Use Edit to add one." />
            {current && textState && (
              <div style={{ marginTop: 8, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: textState.color, fontWeight: 600 }}>{textState.label}</span>
                {current.textStatus === 'done' && (
                  <span className="ar-muted">
                    {current.textMethod === 'pdf-text' ? 'Taken from the PDF' : 'Recognised from the image (Arabic and English)'} · its words are searchable
                  </span>
                )}
                {current.textStatus === 'failed' && current.textError && <span className="ar-muted">{current.textError}</span>}
                {(current.textStatus === 'failed' || current.textStatus === 'none') && (
                  <button className="ar-btn ar-btn-light ar-btn-sm" onClick={() => readAgain(current.id)}>Read text again</button>
                )}
              </div>
            )}
          </div>

          <div>
            <h4 style={{ margin: '0 0 12px', fontSize: 17 }} dir="auto">{doc.subject}</h4>
            <dl className="ar-details">
              {row('Date', fmtDay(doc.docDate))}
              {row('Reference no.', doc.referenceNo)}
              {row(partyLabel(doc.type, group), doc.party)}
              {row('Department', doc.department)}
              {fields.amount && row('Amount', doc.amount !== null && doc.amount !== undefined ? fmtAmount(doc.amount, doc.currency) : null)}
              {fields.dates && row('Start date', doc.startDate ? fmtDay(doc.startDate) : null)}
              {doc.endDate && row('End / expiry', (
                <span>
                  {fmtDay(doc.endDate)}{' '}
                  {days !== null && (
                    <span className="ar-muted">({days < 0 ? `expired ${-days} days ago` : days === 0 ? 'expires today' : `in ${days} days`})</span>
                  )}
                </span>
              ))}
              {row('Keywords', doc.keywords)}
              {row('Paper kept at', doc.paperLocation)}
              {row('Linked assets', doc.assets.length ? (
                <span className="ar-chips">
                  {doc.assets.map((a) => (
                    <span key={a.assetId} className="ar-chip" title={[a.brandModel, a.serialNumber && `SN ${a.serialNumber}`, a.assignedTo].filter(Boolean).join(' · ')}>
                      {a.assetId}{a.assetType ? ` · ${a.assetType}` : ''}
                    </span>
                  ))}
                </span>
              ) : null)}
              {row('Notes', doc.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</span> : null)}
              {row('Scans', `${doc.files.length}`)}
              {row('Recorded by', `${doc.createdBy || '—'} · ${fmtDbTime(doc.createdAt)}`)}
              {doc.updatedAt && doc.updatedAt !== doc.createdAt && row('Last change', fmtDbTime(doc.updatedAt))}
            </dl>
          </div>
        </div>
      </div>
    </Modal>
  );
}
