// src/components/DocumentForm.jsx — file scans as a new document, or edit a saved one.
// The scan shows on the left while the details are typed on the right.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDocument,
  updateDocument,
  getNextDocumentId,
  getDocument,
  uploadScans,
  addDocumentFiles,
  removeDocumentFile,
} from '../utils/api';
import { departments } from '../data/departments';
import { GROUP_FIELDS, groupOf, partyLabel, todayLocal } from '../utils/archive';
import Modal from './Modal';
import ScanPreview from './ScanPreview';
import AssetPicker from './AssetPicker';

const OTHER_TYPE = '__other__';
const CURRENCIES = ['BHD', 'USD', 'EUR', 'SAR', 'AED', 'KWD'];
const GROUP_ORDER = ['Purchase', 'Contracts', 'Correspondence', 'Other'];

const emptyForm = (doc) => ({
  type: doc?.type || '',
  otherType: '',
  subject: doc?.subject || '',
  docDate: doc?.docDate || todayLocal(),
  referenceNo: doc?.referenceNo || '',
  party: doc?.party || '',
  department: doc?.department || '',
  amount: doc?.amount ?? '',
  currency: doc?.currency || 'BHD',
  startDate: doc?.startDate || '',
  endDate: doc?.endDate || '',
  keywords: doc?.keywords || '',
  notes: doc?.notes || '',
  paperLocation: doc?.paperLocation || '',
});

// mode "new": scanIds are the scans from "To file" to file under the new document.
// mode "edit": doc is the saved document (with files and assets).
export default function DocumentForm({
  mode, doc, scanIds: initialScanIds = [], inbox = [], types = [], parties = [],
  hasNext = false, onClose, onSaved, onInboxChange,
}) {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState(() => emptyForm(doc));
  const [assets, setAssets] = useState(() => (doc?.assets || []).map((a) => ({ assetId: a.assetId, assetType: a.assetType })));
  const [scanIds, setScanIds] = useState(initialScanIds);
  const [files, setFiles] = useState(doc?.files || []); // edit mode: the document's scans
  const [previewId, setPreviewId] = useState(null);
  const [idPreview, setIdPreview] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const previewSeq = useRef(0);
  const fileInput = useRef();

  const effectiveType = form.type === OTHER_TYPE ? form.otherType.trim() : form.type;
  const group = groupOf(effectiveType, types);
  const fields = GROUP_FIELDS[group] || GROUP_FIELDS.Other;

  // The scans shown on the left
  const shownFiles = isEdit ? files : scanIds.map((id) => inbox.find((f) => f.id === id)).filter(Boolean);
  const otherInbox = inbox.filter((f) => !scanIds.includes(f.id));

  // A new document's ID, once its type and date are known
  useEffect(() => {
    if (isEdit) return undefined;
    const seq = ++previewSeq.current;
    if (!effectiveType || !/^\d{4}-\d{2}-\d{2}$/.test(form.docDate)) { setIdPreview(''); return undefined; }
    const t = setTimeout(async () => {
      try {
        const id = await getNextDocumentId(effectiveType, form.docDate);
        if (seq === previewSeq.current) setIdPreview(id);
      } catch {
        if (seq === previewSeq.current) setIdPreview('');
      }
    }, 250);
    return () => clearTimeout(t);
  }, [isEdit, effectiveType, form.docDate]);

  const typeGroups = useMemo(() => GROUP_ORDER.map((g) => ({ group: g, list: types.filter((t) => t.group === g) }))
    .filter((g) => g.list.length), [types]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const reloadFiles = async () => {
    const fresh = await getDocument(doc.id);
    setFiles(fresh.files || []);
  };

  // New scans chosen from the computer: they go to "To file" first, then under this document
  const handleUpload = async (fileList) => {
    if (!fileList?.length) return;
    setUploading(true);
    setError('');
    try {
      if (isEdit) {
        await addDocumentFiles(doc.id, fileList);
        await reloadFiles();
      } else {
        const added = await uploadScans(fileList);
        setScanIds((ids) => [...ids, ...added.map((f) => f.id)]);
        if (onInboxChange) await onInboxChange();
        setPreviewId(added[0]?.id ?? null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const addFromInbox = async (fileId) => {
    if (!fileId) return;
    const id = Number(fileId);
    if (isEdit) {
      try {
        await addDocumentFiles(doc.id, [], [id]);
        await reloadFiles();
        if (onInboxChange) await onInboxChange();
      } catch (err) { setError(err.message); }
    } else {
      setScanIds((ids) => [...ids, id]);
      setPreviewId(id);
    }
  };

  const removeScan = async (file) => {
    if (!isEdit) {
      setScanIds((ids) => ids.filter((x) => x !== file.id));
      return;
    }
    if (!window.confirm(`Take "${file.originalName}" out of this document?\n\nThe file is kept on the server, not deleted.`)) return;
    try {
      await removeDocumentFile(doc.id, file.id);
      await reloadFiles();
    } catch (err) { setError(err.message); }
  };

  const save = async (andNext) => {
    setError('');
    if (!effectiveType) { setError('Choose the document type, or choose "Other" and type a new one.'); return; }
    if (!form.subject.trim()) { setError('Enter the subject.'); return; }
    if (!form.docDate) { setError('Enter the date written on the document.'); return; }
    const details = {
      type: effectiveType,
      subject: form.subject,
      docDate: form.docDate,
      referenceNo: form.referenceNo,
      party: form.party,
      department: form.department,
      amount: fields.amount ? form.amount : '',
      currency: form.currency,
      startDate: fields.dates ? form.startDate : '',
      endDate: fields.dates ? form.endDate : '',
      keywords: form.keywords,
      notes: form.notes,
      paperLocation: form.paperLocation,
      assetIds: assets.map((a) => a.assetId),
    };
    setSaving(true);
    try {
      if (isEdit) {
        await updateDocument(doc.id, details);
        onSaved(doc.id, { andNext: false });
      } else {
        const result = await createDocument({ ...details, fileIds: scanIds });
        onSaved(result.id, { andNext });
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} maxWidth={1200}>
      <div className="ar">
        <div className="ar-head">
          <h3>{isEdit ? `Edit ${doc.id}` : 'File a document'}</h3>
          {!isEdit && idPreview && <span className="ar-id-preview" title="The next free number is taken when you save">{idPreview}</span>}
        </div>

        <div className="ar-dialog">
          {/* Left: the scans */}
          <div>
            <ScanPreview
              files={shownFiles}
              selectedId={previewId}
              onSelect={setPreviewId}
              emptyText="No scan yet. Add one below, or save the details now and add the scan later."
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <button type="button" className="ar-btn ar-btn-light ar-btn-sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? 'Uploading…' : 'Upload more scans'}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                style={{ display: 'none' }}
                onChange={(e) => handleUpload(e.target.files)}
              />
              {otherInbox.length > 0 && (
                <select className="ar-input" style={{ width: 'auto', height: 30, fontSize: 13 }} value="" onChange={(e) => addFromInbox(e.target.value)}>
                  <option value="">Add a scan from To file ({otherInbox.length})…</option>
                  {otherInbox.map((f) => <option key={f.id} value={f.id}>{f.originalName}</option>)}
                </select>
              )}
            </div>
            {shownFiles.length > 0 && (
              <div className="ar-filelist" style={{ marginTop: 10 }}>
                {shownFiles.map((f, i) => (
                  <div key={f.id} className="ar-fileitem">
                    <span>{i + 1}. {f.originalName}</span>
                    <button type="button" className="ar-btn ar-btn-danger ar-btn-sm" onClick={() => removeScan(f)}>
                      {isEdit ? 'Take out' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: the details */}
          <form onSubmit={(e) => { e.preventDefault(); save(false); }}>
            {error && <div className="ar-error" role="alert">{error}</div>}

            <div className="ar-grid-2">
              <div className="ar-field">
                <label htmlFor="doc-type">Type *</label>
                <select id="doc-type" className="ar-input" value={form.type} onChange={set('type')} autoFocus={!isEdit}>
                  <option value="">Choose a type</option>
                  {typeGroups.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.list.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.code})</option>)}
                    </optgroup>
                  ))}
                  <option value={OTHER_TYPE}>Other (new type)…</option>
                </select>
                {form.type === OTHER_TYPE && (
                  <input className="ar-input" style={{ marginTop: 6 }} value={form.otherType} onChange={set('otherType')} placeholder="New type, e.g. Insurance Policy" autoFocus />
                )}
              </div>
              <div className="ar-field">
                <label htmlFor="doc-date">Date on the document *</label>
                <input id="doc-date" type="date" className="ar-input" value={form.docDate} onChange={set('docDate')} />
              </div>
            </div>

            <div className="ar-field">
              <label htmlFor="doc-subject">Subject *</label>
              <input id="doc-subject" className="ar-input" value={form.subject} onChange={set('subject')} placeholder="Dell laptops for Finance department" />
            </div>

            <div className="ar-grid-2">
              <div className="ar-field">
                <label htmlFor="doc-ref">Reference number</label>
                <input id="doc-ref" className="ar-input" value={form.referenceNo} onChange={set('referenceNo')} placeholder="The number printed on the paper" />
              </div>
              <div className="ar-field">
                <label htmlFor="doc-party">{partyLabel(effectiveType, group)}</label>
                <input id="doc-party" className="ar-input" list="doc-parties" value={form.party} onChange={set('party')} />
                <datalist id="doc-parties">{parties.map((p) => <option key={p} value={p} />)}</datalist>
              </div>
            </div>

            <div className="ar-grid-2">
              <div className="ar-field">
                <label htmlFor="doc-dept">Department</label>
                <select id="doc-dept" className="ar-input" value={form.department} onChange={set('department')}>
                  <option value="">—</option>
                  {form.department && !departments.includes(form.department) && <option value={form.department}>{form.department}</option>}
                  {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              {fields.amount && (
                <div className="ar-field">
                  <label htmlFor="doc-amount">Amount</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input id="doc-amount" type="number" step="0.001" min="0" className="ar-input" value={form.amount} onChange={set('amount')} />
                    <select className="ar-input" style={{ width: 90 }} value={form.currency} onChange={set('currency')} aria-label="Currency">
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {fields.dates && (
              <div className="ar-grid-2">
                <div className="ar-field">
                  <label htmlFor="doc-start">Start date</label>
                  <input id="doc-start" type="date" className="ar-input" value={form.startDate} onChange={set('startDate')} />
                </div>
                <div className="ar-field">
                  <label htmlFor="doc-end">End / expiry date</label>
                  <input id="doc-end" type="date" className="ar-input" value={form.endDate} onChange={set('endDate')} />
                  <div className="ar-hint">The Dashboard warns 90 days before this date.</div>
                </div>
              </div>
            )}

            <div className="ar-section">Finding it later</div>
            <div className="ar-field">
              <label htmlFor="doc-keywords">Keywords</label>
              <input id="doc-keywords" className="ar-input" value={form.keywords} onChange={set('keywords')} placeholder="Words people may search with, e.g. printers, Dell, صيانة" />
            </div>
            <div className="ar-field">
              <label htmlFor="doc-paper">Where the paper is kept</label>
              <input id="doc-paper" className="ar-input" value={form.paperLocation} onChange={set('paperLocation')} placeholder="Cabinet 2, Box 5, File 12 (optional)" />
            </div>
            <div className="ar-field">
              <label>Linked assets</label>
              <AssetPicker value={assets} onChange={setAssets} />
            </div>
            <div className="ar-field">
              <label htmlFor="doc-notes">Notes</label>
              <textarea id="doc-notes" className="ar-input" value={form.notes} onChange={set('notes')} />
            </div>

            <div className="ar-actions">
              <button type="button" className="ar-btn ar-btn-light" onClick={onClose}>Cancel</button>
              {!isEdit && hasNext && (
                <button type="button" className="ar-btn ar-btn-light" disabled={saving} onClick={() => save(true)}>
                  Save and file next
                </button>
              )}
              <button type="submit" className="ar-btn ar-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save document'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Modal>
  );
}
