import React, { useState, useEffect, useRef } from 'react';
import {
  addAsset,
  updateAsset,
  getNextAssetId,
  uploadInvoice,
  checkSerialDuplicate,
  uploadImage,
  getImages,
  deleteImage,
} from '../utils/api';
import { groups } from '../data/groups';
import { categories } from '../data/categories';
import { API_URL } from '../utils/api';
import { departments } from '../data/departments';
const resolveUrl = (u) => (u && u.startsWith('/') ? `${API_URL}${u}` : u);
const DEPT_OTHER = 'أخرى'; // unified value for "Other" department
export default function AssetForm({ onSave, editData }) {
  const isEdit = !!editData;
  const [formData, setFormData] = useState(null);
  const [originalId, setOriginalId] = useState(null);

  // --- Multiple upload selection (client-side) ---
  const [invoiceFiles, setInvoiceFiles] = useState([]);   // Array<File>
  const [invoiceUploading, setInvoiceUploading] = useState(false);
  const [invoiceErrors, setInvoiceErrors] = useState([]); // Array<string>

  // --- Invoices from backend (authoritative, includes ids for deletion) ---
  const [invoices, setInvoices] = useState([]);            // [{id, url, uploadedAt}]
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoiceActionError, setInvoiceActionError] = useState('');

  // --- Images ---
  const [imageFiles, setImageFiles]           = useState([]);   // File[] selected but not yet uploaded
  const [imageUploading, setImageUploading]   = useState(false);
  const [imageErrors, setImageErrors]         = useState([]);
  const [images, setImages]                   = useState([]);   // [{id,url,uploadedAt}] from backend
  const [imagesLoading, setImagesLoading]     = useState(false);
  const [imageActionError, setImageActionError] = useState('');

  const STATUS_OPTIONS = ['Active', 'Not active', 'Retired', 'Suspended'];

  const [showAdvanced, setShowAdvanced]     = useState(false);
  const [serialDuplicate, setSerialDuplicate] = useState(null); // null | { assetId }
  const serialCheckTimer = useRef(null);

  // extra fields for "Other"
  const [otherGroup, setOtherGroup] = useState('');
  const [otherAssetType, setOtherAssetType] = useState('');
const [otherDepartment, setOtherDepartment] = useState('');
  // Required core fields
  const requiredFields = ['assetId', 'group', 'assetType'];

  useEffect(() => {
    if (isEdit) {
      setFormData(prev => ({
        assetId: '', group: '', assetType: '', brandModel: '', serialNumber: '', assignedTo: '', hostName: '',department: '',
        ipAddress: '', macAddress: '', osFirmware: '', cpu: '', ram: '', storage: '',
        portDetails: '', powerConsumption: '', purchaseDate: '', warrantyExpiry: '', eol: '',
        maintenanceExpiry: '', cost: '', depreciation: '', residualValue: '', status: '',
        condition: '', usagePurpose: '', accessLevel: '', licenseKey: '', complianceStatus: '',
        documentation: '', remarks: '', lastAuditDate: '', disposedDate: '', replacementPlan: '',
        invoiceUrl: '',
        invoiceUrls: [],

        brand: '',
        model: '',
        ...editData
      }));
      setOriginalId(editData.assetId);

      // Pre-fill split brand/model from brandModel into formData
      const bm = (editData?.brandModel || '').trim();
      const idx = bm.indexOf(' ');
      const splitBrand = idx > -1 ? bm.slice(0, idx).trim() : bm;
      const splitModel = idx > -1 ? bm.slice(idx + 1).trim() : '';
      setFormData(prev => ({ ...prev, brand: splitBrand, model: splitModel }));

      // Normalize invoiceUrls from legacy invoiceUrl if needed
      setFormData(prev => {
        const normalized = Array.isArray(prev?.invoiceUrls)
          ? prev.invoiceUrls
          : (prev?.invoiceUrl ? [prev.invoiceUrl] : []);
        return { ...prev, invoiceUrls: normalized };
      });

      // If editing and the current values are not in the predefined lists, show them as "Other"
      if (editData?.group && !groups.includes(editData.group)) {
        setOtherGroup(editData.group);
        setFormData((prev) => ({ ...prev, group: 'Other' }));
      }
      if (editData?.assetType && !categories.includes(editData.assetType)) {
        setOtherAssetType(editData.assetType);
        setFormData((prev) => ({ ...prev, assetType: 'Other' }));
      }
    if (editData?.department && !departments.includes(editData.department)) {
      setOtherDepartment(editData.department);
      setFormData((prev) => ({ ...prev, department: DEPT_OTHER }));
    }
    } else {
      const init = async () => {
        setFormData({
          assetId: '',
          group: '',
          assetType: '',
          brandModel: '',
          brand: '',
          model: '',
          serialNumber: '',
          hostName: '',
          assignedTo: '',
          department: '',
          ipAddress: '',
          macAddress: '',
          osFirmware: '',
          cpu: '',
          ram: '',
          storage: '',
          portDetails: '',
          powerConsumption: '',
          purchaseDate: '',
          warrantyExpiry: '',
          eol: '',
          maintenanceExpiry: '',
          cost: '',
          depreciation: '',
          residualValue: '',
          status: '',
          condition: '',
          usagePurpose: '',
          accessLevel: '',
          licenseKey: '',
          complianceStatus: '',
          documentation: '',
          remarks: '',
          lastAuditDate: '',
          disposedDate: '',
          replacementPlan: '',
          invoiceUrl: '',
          invoiceUrls: []
        });
      };
      init();
    }
  }, [editData, isEdit]);

  // Load invoices + images from backend whenever assetId is available
  useEffect(() => {
    if (!formData?.assetId) return;
    loadInvoices(formData.assetId);
    loadImages(formData.assetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData?.assetId]);

  const loadInvoices = async (assetId) => {
    setInvoicesLoading(true);
    setInvoiceActionError('');
    try {
      const res = await fetch(`${API_URL}/assets/${encodeURIComponent(assetId)}/invoices`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to load invoices');
      const data = await res.json();

      // Expected: { invoices: [{id,url,uploadedAt}, ...] }
      if (Array.isArray(data?.invoices)) {
        setInvoices(data.invoices);
      } else if (Array.isArray(data?.invoiceUrls)) {
        // Legacy fallback (no ids => deletion disabled)
        setInvoices(data.invoiceUrls.map((url) => ({ id: null, url, uploadedAt: '' })));
      } else {
        setInvoices([]);
      }
    } catch (e) {
      setInvoiceActionError(e.message || 'Error loading invoices');
      setInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  };

  const loadImages = async (assetId) => {
    setImagesLoading(true);
    setImageActionError('');
    try {
      const data = await getImages(assetId);
      setImages(Array.isArray(data?.images) ? data.images : []);
    } catch (e) {
      setImageActionError(e.message || 'Error loading images');
      setImages([]);
    } finally {
      setImagesLoading(false);
    }
  };

  const handleDeleteImage = async (img) => {
    if (!formData?.assetId || !img?.id) return;
    if (!window.confirm('Delete this image permanently?')) return;
    setImageActionError('');
    try {
      await deleteImage(formData.assetId, img.id);
      await loadImages(formData.assetId);
    } catch (e) {
      setImageActionError(e.message || 'Error deleting image');
    }
  };

  const handleDeleteInvoice = async (inv) => {
    if (!formData?.assetId || !inv?.id) return;
    const ok = window.confirm('Are you sure you want to permanently delete this invoice?');
    if (!ok) return;

    setInvoiceActionError('');
    try {
      const res = await fetch(
        `${API_URL}/assets/${encodeURIComponent(formData.assetId)}/invoices/${encodeURIComponent(inv.id)}?confirm=true`,
        { method: 'DELETE', credentials: 'include' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Delete failed');

      // refresh list and sync legacy latest url if provided
      await loadInvoices(formData.assetId);
      if ('latestInvoiceUrl' in data) {
        setFormData(prev => ({ ...prev, invoiceUrl: data.latestInvoiceUrl || '' }));
      }

      alert('Invoice deleted.');
    } catch (e) {
      setInvoiceActionError(e.message || 'Error deleting invoice');
    }
  };

  const handleChange = async (e) => {
    const { name, value } = e.target;

    // Special handling for selects
    if (name === 'group') {
      setFormData((prev) => ({ ...prev, group: value }));
      return;
    }
if (name === 'department') {
  setFormData((prev) => ({ ...prev, department: value }));
  if (value !== DEPT_OTHER) setOtherDepartment('');
  return;
}
    if (name === 'assetType') {
      if (value === 'Other') {
        // Wait for user to type custom asset type; clear assetId until then
        setFormData((prev) => ({ ...prev, assetType: value, assetId: '' }));
      } else {
        try {
          const newId = await getNextAssetId(value);
          setFormData((prev) => ({
            ...prev,
            assetType: value,
            assetId: newId
          }));
        } catch (err) {
          alert('Failed to generate asset ID: ' + err.message);
        }
      }
      return;
    }

    // Regular fields
    setFormData((prev) => ({
      ...prev,
      [name]: value
    }));
  };

  // Handle "Other" text inputs
  const handleOtherGroupChange = (e) => {
    setOtherGroup(e.target.value);
  };

  const handleOtherAssetTypeChange = async (e) => {
    const val = e.target.value;
    setOtherAssetType(val);

    // Generate ID dynamically from custom asset type when user types it
    if (val && val.trim().length >= 2) {
      try {
        const newId = await getNextAssetId(val.trim());
        setFormData((prev) => ({ ...prev, assetId: newId }));
      } catch {
        // ignore typing errors
      }
    } else {
      // Too short; clear the ID
      setFormData((prev) => ({ ...prev, assetId: '' }));
    }
  };

  const essentialSection = {
    title: 'Essential Info',
    fields: ['assetId', 'group', 'assetType', 'brand', 'model', 'serialNumber', 'assignedTo', 'department', 'status']
  };

  const advancedSections = [
    {
      title: 'Technical Details',
      fields: ['hostName', 'ipAddress', 'macAddress', 'osFirmware', 'cpu', 'ram', 'storage', 'portDetails', 'powerConsumption']
    },
    {
      title: 'Lifecycle Info',
      fields: ['purchaseDate', 'warrantyExpiry', 'eol', 'maintenanceExpiry']
    },
    {
      title: 'Financial Info',
      fields: ['cost', 'depreciation', 'residualValue']
    },
    {
      title: 'Condition & Usage',
      fields: ['condition', 'usagePurpose', 'accessLevel']
    },
    {
      title: 'Compliance & Documentation',
      fields: ['licenseKey', 'complianceStatus', 'documentation']
    },
    {
      title: 'Additional Info',
      fields: ['remarks', 'lastAuditDate', 'disposedDate', 'replacementPlan']
    }
  ];

  const checkSerial = (value) => {
    clearTimeout(serialCheckTimer.current);
    setSerialDuplicate(null);
    if (!value || value.trim().length < 3) return;
    serialCheckTimer.current = setTimeout(async () => {
      try {
        const result = await checkSerialDuplicate(value.trim(), isEdit ? originalId : undefined);
        setSerialDuplicate(result.exists ? result : null);
      } catch { /* ignore */ }
    }, 500);
  };

  const numericFields = ['ram', 'storage', 'powerConsumption', 'cost', 'depreciation', 'residualValue'];

  const humanize = (field) =>
    field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData) return;

    // Dynamic required rules
    const missing = [];
if (formData.department === DEPT_OTHER && (!otherDepartment || !otherDepartment.trim())) {    missing.push('otherDepartment');
  }
 // base required
    requiredFields.forEach((f) => {
      if (!formData[f] || String(formData[f]).trim() === '') {
        missing.push(f);
      }
    });

    // when "Other" is selected, require the custom text
    if (formData.group === 'Other' && (!otherGroup || !otherGroup.trim())) {
      missing.push('otherGroup');
    }
    if (formData.assetType === 'Other' && (!otherAssetType || !otherAssetType.trim())) {
      missing.push('otherAssetType');
    }

    if (missing.length) {
      alert(`Please fill required fields: ${missing.map(humanize).join(', ')}`);
      return;
    }

    // Normalize payload: replace "Other" with the typed values
    const payload = {
      ...formData,
      group: formData.group === 'Other' ? otherGroup.trim() : formData.group,
      assetType: formData.assetType === 'Other' ? otherAssetType.trim() : formData.assetType,
department: formData.department === DEPT_OTHER ? otherDepartment.trim() : formData.department    };

    // Compose brandModel from current form values (single source of truth)
    const bm = `${(formData.brand || '').trim()} ${(formData.model || '').trim()}`.trim();
    if (bm) payload.brandModel = bm;

    try {
      const effectiveId = formData.assetId;

      if (isEdit) {
        await updateAsset(payload, originalId || effectiveId);
      } else {
        await addAsset(payload);
      }

      // Upload all selected PDFs (if any) and append returned URLs into invoiceUrls
      if (invoiceFiles.length > 0 && effectiveId) {
        setInvoiceUploading(true);
        try {
          const results = await Promise.all(
            invoiceFiles.map((f) => uploadInvoice(effectiveId, f))
          );
          const urls = results.map(r => r?.url).filter(Boolean);
          if (urls.length > 0) {
            setFormData(prev => ({
              ...prev,
              invoiceUrls: [...(prev?.invoiceUrls || []), ...urls]
            }));
          }
          // refresh invoices list from backend (to get ids)
          await loadInvoices(effectiveId);
          setInvoiceFiles([]); // clear selection after upload
        } finally {
          setInvoiceUploading(false);
        }
      }

      // Upload selected images
      if (imageFiles.length > 0 && effectiveId) {
        setImageUploading(true);
        try {
          await Promise.all(imageFiles.map((f) => uploadImage(effectiveId, f)));
          await loadImages(effectiveId);
          setImageFiles([]);
        } finally {
          setImageUploading(false);
        }
      }

      alert(isEdit ? 'Asset updated' : 'Asset added');
      if (onSave) onSave();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
const handleOtherDepartmentChange = (e) => {
  setOtherDepartment(e.target.value);
};

  if (!formData) return <p>Loading form...</p>;

  const isAssetIdReadOnly = !isEdit; // ID is auto-generated in add mode
  const mustHaveGroupText = formData.group === 'Other';
  const mustHaveTypeText = formData.assetType === 'Other';
const mustHaveDepartmentText = formData.department === DEPT_OTHER;
  const isSubmitDisabled =
    !formData.group ||
    !formData.assetType ||
    !formData.assetId ||
    (mustHaveGroupText && !otherGroup.trim()) ||
    (mustHaveTypeText && !otherAssetType.trim()) ||
    (mustHaveDepartmentText && !otherDepartment.trim());
  const renderField = (field) => {
    const isDate     = field.toLowerCase().includes('date');
    const isTextArea = ['remarks', 'documentation'].includes(field);
    const isGroup      = field === 'group';
    const isStatus     = field === 'status';
    const isDepartment = field === 'department';
    const isAssetType  = field === 'assetType';
    const isAssetId    = field === 'assetId';
    const isSerial     = field === 'serialNumber';
    const isNumeric    = numericFields.includes(field);
    const label = humanize(field);

    return (
      <div key={field} style={fieldRow}>
        <label style={labelStyle}>
          {label}{['assetId', 'group', 'assetType'].includes(field) ? ' *' : ''}:
        </label>

        {isGroup ? (
          <>
            <select name="group" value={formData.group} onChange={handleChange} style={inputStyle} required>
              <option value="">Select</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              <option value="Other">Other</option>
            </select>
            {mustHaveGroupText && (
              <input type="text" value={otherGroup} onChange={handleOtherGroupChange}
                placeholder="Enter custom group" style={{ ...inputStyle, marginTop: 6 }} required />
            )}
          </>
        ) : isDepartment ? (
          <>
            <select name="department" value={formData.department || ''} onChange={handleChange} style={inputStyle}>
              <option value="">Select</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              {!departments.includes(DEPT_OTHER) && <option value={DEPT_OTHER}>{DEPT_OTHER} (Other)</option>}
            </select>
            {formData.department === DEPT_OTHER && (
              <input type="text" value={otherDepartment} onChange={handleOtherDepartmentChange}
                placeholder="أدخل قسماً مخصصاً" style={{ ...inputStyle, marginTop: 6 }} required />
            )}
          </>
        ) : isAssetType ? (
          <>
            <select name="assetType" value={formData.assetType} onChange={handleChange} style={inputStyle} required>
              <option value="">Select</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="Other">Other</option>
            </select>
            {mustHaveTypeText && (
              <input type="text" value={otherAssetType} onChange={handleOtherAssetTypeChange}
                placeholder="Enter custom asset type" style={{ ...inputStyle, marginTop: 6 }} required />
            )}
          </>
        ) : isTextArea ? (
          <textarea name={field} value={formData[field]} onChange={handleChange} rows="3" style={inputStyle} />
        ) : isAssetId ? (
          <input
            type="text" name={field} value={formData[field]} onChange={handleChange}
            style={{ ...inputStyle, backgroundColor: isAssetIdReadOnly ? '#f0f0f0' : '#fff', color: isAssetIdReadOnly ? '#555' : '#000' }}
            readOnly={isAssetIdReadOnly} required
            placeholder={!formData.assetId ? (formData.assetType === 'Other' ? 'Type custom asset type to generate ID' : 'Select Asset Type to generate ID') : undefined}
          />
        ) : isStatus ? (
          <select name="status" value={formData.status || ''} onChange={handleChange} style={inputStyle}>
            <option value="">Select</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : isSerial ? (
          <>
            <input
              type="text" name={field} value={formData[field]}
              onChange={(e) => { handleChange(e); checkSerial(e.target.value); }}
              style={inputStyle}
            />
            {serialDuplicate && (
              <div style={{ color: '#dc2626', fontSize: '13px', marginTop: 4 }}>
                ⚠ Serial already used by <strong>{serialDuplicate.assetId}</strong>
              </div>
            )}
          </>
        ) : (
          <input
            type={isDate ? 'date' : isNumeric ? 'number' : 'text'}
            name={field} value={formData[field]} onChange={handleChange} style={inputStyle}
          />
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit} style={formContainer}>
      <h2 style={formHeader}>{isEdit ? 'Edit Asset' : 'Add New Asset'}</h2>

      {/* Essential fields — always visible */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>{essentialSection.title}</legend>
        {essentialSection.fields.map((field) => renderField(field))}

        {/* ---- Asset Images ---- */}
        <div style={fieldRow}>
          <label style={labelStyle}>Photos / Images</label>

          {/* File picker — on iOS shows: Take Photo / Photo Library / Browse */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={imgPickerBtnStyle}>
              📷 Take Photo / Choose Image
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  const errs = [];
                  const valid = [];
                  files.forEach((f) => {
                    if (f.size > 10 * 1024 * 1024) { errs.push(`${f.name}: too large (max 10 MB)`); return; }
                    valid.push(f);
                  });
                  setImageErrors(errs);
                  setImageFiles((prev) => [...prev, ...valid]);
                  e.target.value = '';
                }}
              />
            </label>
            {imageUploading && <span style={{ color: '#6b7280', fontSize: 13 }}>Uploading…</span>}
          </div>

          {imageErrors.length > 0 && (
            <div style={{ color: '#dc2626', fontSize: 13, marginTop: 4 }}>{imageErrors.join(' • ')}</div>
          )}

          {/* Previews of selected-but-not-yet-uploaded files */}
          {imageFiles.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {imageFiles.map((f, i) => (
                <div key={i} style={imgThumbWrap}>
                  <img src={URL.createObjectURL(f)} alt={f.name} style={imgThumb} />
                  <button
                    type="button"
                    onClick={() => setImageFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    style={imgDeleteBtn}
                    aria-label="Remove"
                  >✕</button>
                  <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', marginTop: 2 }}>
                    {Math.ceil(f.size / 1024)} KB
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Uploaded images from backend */}
          {imagesLoading ? (
            <span style={{ color: '#6b7280', fontSize: 13, marginTop: 6, display: 'block' }}>Loading images…</span>
          ) : images.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
              {images.map((img, idx) => (
                <div key={img.id ?? `img-${idx}`} style={{ ...imgThumbWrap, width: 100 }}>
                  <a href={resolveUrl(img.url)} target="_blank" rel="noopener noreferrer">
                    <img src={resolveUrl(img.url)} alt={`Asset image ${idx + 1}`} style={imgThumb} />
                  </a>
                  <button
                    type="button"
                    onClick={() => handleDeleteImage(img)}
                    style={imgDeleteBtn}
                    aria-label="Delete image"
                    disabled={!img.id}
                  >✕</button>
                  {img.uploadedAt && (
                    <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'center', marginTop: 2 }}>
                      {img.uploadedAt.slice(0, 10)}
                    </div>
                  )}
                  {/* OCR extracted text — shown as expandable chip */}
                  {img.ocrText ? (
                    <OcrChip text={img.ocrText} />
                  ) : (
                    <div style={{ fontSize: 10, color: '#d1d5db', textAlign: 'center', marginTop: 2 }}>scanning…</div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {imageActionError && (
            <div style={{ color: '#dc2626', fontSize: 13, marginTop: 4 }}>{imageActionError}</div>
          )}
        </div>
      </fieldset>

      {/* Toggle for advanced sections */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <button type="button" onClick={() => setShowAdvanced(v => !v)} style={toggleBtnStyle}>
          {showAdvanced ? 'Hide Details ▴' : 'More Details ▾'}
        </button>
      </div>

      {/* Advanced sections — hidden until toggled */}
      {showAdvanced && advancedSections.map((section) => (
        <fieldset key={section.title} style={fieldsetStyle}>
          <legend style={legendStyle}>{section.title}</legend>
          {section.fields.map((field) => renderField(field))}

          {section.title === 'Compliance & Documentation' && (
            <div style={fieldRow}>
              <label style={labelStyle}>Invoices (PDF, multiple)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="file" accept="application/pdf" multiple
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    const errors = [];
                    const valid = [];
                    files.forEach((f) => {
                      if (f.size > 10 * 1024 * 1024) { errors.push(`${f.name}: too large (max 10 MB)`); return; }
                      valid.push(f);
                    });
                    setInvoiceErrors(errors);
                    setInvoiceFiles(valid);
                  }}
                  style={inputStyle}
                />
                {invoiceUploading && <span style={{ color: '#6b7280' }}>Uploading…</span>}
                {invoiceErrors.length > 0 && <span style={{ color: '#dc2626' }}>{invoiceErrors.join(' • ')}</span>}
              </div>

              {invoiceFiles.length > 0 && (
                <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                  {invoiceFiles.map((f, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{f.name} ({Math.ceil(f.size / 1024)} KB)</span>
                      <button type="button"
                        onClick={() => setInvoiceFiles(prev => prev.filter((_, idx) => idx !== i))}
                        style={{ border: 'none', background: '#eee', padding: '2px 6px', borderRadius: 4, cursor: 'pointer' }}
                        aria-label={`Remove ${f.name}`}>× Remove</button>
                    </li>
                  ))}
                </ul>
              )}

              <div style={{ marginTop: 6 }}>
                {invoicesLoading ? (
                  <span style={{ color: '#6b7280' }}>Loading invoices…</span>
                ) : invoices.length ? (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {invoices.map((inv, idx) => (
                      <li key={inv.id ?? `noid-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <a href={resolveUrl(inv.url)} target="_blank" rel="noopener noreferrer">Invoice {idx + 1}</a>
                        {inv.uploadedAt ? <small style={{ color: '#6b7280' }}>{inv.uploadedAt}</small> : null}
                        <button type="button" onClick={() => handleDeleteInvoice(inv)}
                          style={deleteBtnStyle} aria-label="Delete invoice"
                          title={inv.id ? 'Delete invoice' : 'Delete not available (legacy)'}
                          disabled={!inv.id}>Delete</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span style={{ color: '#6b7280' }}>No invoices yet.</span>
                )}
                {invoiceActionError && <div style={{ color: '#dc2626', marginTop: 6 }}>{invoiceActionError}</div>}
              </div>

              {!invoicesLoading && !invoices.length && formData?.invoiceUrl ? (
                <div style={{ marginTop: 6 }}>
                  <a href={resolveUrl(formData.invoiceUrl)} target="_blank" rel="noopener noreferrer">View current invoice</a>
                </div>
              ) : null}
            </div>
          )}
        </fieldset>
      ))}

      <div style={{ textAlign: 'center' }}>
        <button type="submit" style={{ ...submitButtonStyle, opacity: isSubmitDisabled ? 0.7 : 1 }} disabled={isSubmitDisabled}>
          {isEdit ? 'Update Asset' : 'Save Asset'}
        </button>
      </div>
    </form>
  );
}

/* ── OCR chip: shows extracted text under a thumbnail ── */
function OcrChip({ text }) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
  return (
    <div
      onClick={() => setExpanded(v => !v)}
      title={expanded ? 'Click to collapse' : text}
      style={{
        marginTop: 3,
        fontSize: 10,
        color: '#374151',
        background: '#f0fdf4',
        border: '1px solid #bbf7d0',
        borderRadius: 4,
        padding: '2px 5px',
        cursor: 'pointer',
        wordBreak: 'break-all',
        lineHeight: 1.4,
        maxWidth: 100
      }}
    >
      🔍 {expanded ? text : preview}
    </div>
  );
}

// === Styles ===
const formContainer = {
  maxWidth: '900px',
  margin: '0 auto',
  background: '#fff',
  padding: '25px',
  borderRadius: '10px',
  boxShadow: '0 0 10px rgba(0,0,0,0.08)'
};

const formHeader = {
  textAlign: 'center',
  marginBottom: '30px',
  fontSize: '24px',
  color: '#333'
};

const fieldsetStyle = {
  marginBottom: '25px',
  padding: '15px',
  border: '1px solid #ccc',
  borderRadius: '6px'
};

const legendStyle = {
  fontWeight: 'bold',
  fontSize: '16px',
  padding: '0 10px'
};

const fieldRow = {
  display: 'flex',
  flexDirection: 'column',
  marginBottom: '12px'
};

const labelStyle = {
  marginBottom: '4px',
  fontWeight: '500'
};

const inputStyle = {
  padding: '10px',
  fontSize: '16px', // 16px prevents iOS Safari auto-zoom on focus
  borderRadius: '4px',
  border: '1px solid #ccc'
};

const toggleBtnStyle = {
  padding: '10px 24px',
  fontSize: '15px',
  background: '#f0f0f0',
  color: '#333',
  border: '1px solid #ccc',
  borderRadius: '6px',
  cursor: 'pointer'
};

const submitButtonStyle = {
  marginTop: '20px',
  padding: '10px 20px',
  fontSize: '16px',
  background: '#28a745',
  color: '#fff',
  border: 'none',
  borderRadius: '5px',
  cursor: 'pointer'
};

const deleteBtnStyle = {
  padding: '4px 8px',
  fontSize: '12px',
  background: '#ef4444',
  color: '#fff',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer'
};

const imgPickerBtnStyle = {
  display: 'inline-block',
  padding: '10px 16px',
  fontSize: '15px',
  background: '#f0f0f0',
  border: '1px solid #ccc',
  borderRadius: '6px',
  cursor: 'pointer'
};

const imgThumbWrap = {
  position: 'relative',
  width: 90,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center'
};

const imgThumb = {
  width: 90,
  height: 90,
  objectFit: 'cover',
  borderRadius: 6,
  border: '1px solid #ddd'
};

const imgDeleteBtn = {
  position: 'absolute',
  top: 2,
  right: 2,
  background: 'rgba(0,0,0,0.55)',
  color: '#fff',
  border: 'none',
  borderRadius: '50%',
  width: 20,
  height: 20,
  fontSize: 11,
  lineHeight: '20px',
  textAlign: 'center',
  cursor: 'pointer',
  padding: 0
};
