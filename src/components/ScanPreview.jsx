// src/components/ScanPreview.jsx — shows a scan inside the page, page by page, with tabs when a
// document has several scans. PDF pages come as images drawn by the server, so they show the
// same in every browser, iPads included.
import React, { useEffect, useState } from 'react';
import { documentFileUrl, documentPageUrl, getScanMeta } from '../utils/api';
import { fmtSize } from '../utils/archive';

const MAX_PAGES_SHOWN = 100;

export default function ScanPreview({ files, selectedId, onSelect, emptyText = 'No scan to show.' }) {
  const current = files.find((f) => f.id === selectedId) || files[0];
  const isPdf = current?.mimeType === 'application/pdf';
  const [pageCount, setPageCount] = useState(null);

  const currentId = current?.id;
  const knownPages = current?.pages;
  useEffect(() => {
    if (!currentId) return undefined;
    if (!isPdf) { setPageCount(1); return undefined; }
    if (knownPages) { setPageCount(knownPages); return undefined; }
    let alive = true;
    setPageCount(null);
    getScanMeta(currentId)
      .then((m) => { if (alive) setPageCount(m.pages || 1); })
      .catch(() => { if (alive) setPageCount(1); });
    return () => { alive = false; };
  }, [currentId, isPdf, knownPages]);

  return (
    <div>
      {files.length > 1 && (
        <div className="ar-tabs" role="tablist">
          {files.map((f, i) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={f.id === current?.id}
              className={`ar-tab ${f.id === current?.id ? 'on' : ''}`}
              onClick={() => onSelect && onSelect(f.id)}
              title={f.originalName}
            >
              {i + 1}. {f.originalName}
            </button>
          ))}
        </div>
      )}
      <div className="ar-preview">
        {!current ? (
          <div className="ar-preview-empty">{emptyText}</div>
        ) : (
          <div className="ar-preview-pages" key={current.id}>
            {!isPdf ? (
              <img src={documentFileUrl(current.id)} alt={current.originalName} />
            ) : !pageCount ? (
              <div className="ar-preview-empty">Loading pages…</div>
            ) : (
              Array.from({ length: Math.min(pageCount, MAX_PAGES_SHOWN) }, (_, i) => (
                <img
                  key={i}
                  loading="lazy"
                  src={documentPageUrl(current.id, i + 1, 1100)}
                  alt={`Page ${i + 1} of ${current.originalName}`}
                  style={{ aspectRatio: '1 / 1.414' }}
                  onLoad={(e) => { e.currentTarget.style.aspectRatio = 'auto'; }}
                />
              ))
            )}
          </div>
        )}
        {current && (
          <div className="ar-preview-bar">
            <span>
              {current.originalName}
              {current.size ? ` · ${fmtSize(current.size)}` : ''}
              {pageCount ? ` · ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''}
              {pageCount > MAX_PAGES_SHOWN ? ` (first ${MAX_PAGES_SHOWN} shown)` : ''}
            </span>
            <span style={{ display: 'flex', gap: 14 }}>
              <a href={documentFileUrl(current.id)} target="_blank" rel="noopener noreferrer">Open in new tab</a>
              <a href={documentFileUrl(current.id, true)}>Download</a>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
