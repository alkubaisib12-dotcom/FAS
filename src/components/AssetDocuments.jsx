// src/components/AssetDocuments.jsx — the archive documents linked to an asset, shown on its form.
// Links are made from the Archive (Linked assets on a document).
import React, { useEffect, useState } from 'react';
import { getAssetDocuments, documentFileUrl } from '../utils/api';
import { fmtDay } from '../utils/archive';

export default function AssetDocuments({ assetId, fieldsetStyle, legendStyle }) {
  const [docs, setDocs] = useState(null);

  useEffect(() => {
    if (!assetId) return undefined;
    let alive = true;
    getAssetDocuments(assetId)
      .then((rows) => { if (alive) setDocs(rows || []); })
      .catch(() => { if (alive) setDocs([]); });
    return () => { alive = false; };
  }, [assetId]);

  if (!assetId || docs === null) return null;

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Archive documents</legend>
      {docs.length === 0 ? (
        <span style={{ color: '#6b7280' }}>
          No documents linked yet. In the Archive, open a document and add {assetId} under Linked assets.
        </span>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          {docs.map((d) => (
            <li key={d.id}>
              <b>{d.id}</b> · {d.type} · {d.subject}
              <span style={{ color: '#6b7280' }}> · {fmtDay(d.docDate)}{d.party ? ` · ${d.party}` : ''}</span>
              {d.firstFileId && (
                <>
                  {' '}
                  <a href={documentFileUrl(d.firstFileId)} target="_blank" rel="noopener noreferrer">Open scan</a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
