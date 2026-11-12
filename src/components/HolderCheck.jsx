// HolderCheck: compares who is logged on to each device (from ManageEngine or the network scan)
// with who holds that asset in FAS, and lists the differences. Nothing changes until someone
// presses "Use" on a row. A logged-on user is a hint, not proof: IT staff log on to fix PCs,
// and admin accounts are marked so they are not taken for the owner.
//
// devices: [{ serialNumber, macAddress, hostName, assignedTo }]  (assignedTo = logged-on user)
import React, { useState } from 'react';
import { checkHolders, setAssetHolder } from '../utils/api';

export default function HolderCheck({ devices }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState({}); // assetId → name now set

  const run = async () => {
    setBusy(true); setError(''); setRes(null); setDone({});
    try {
      setRes(await checkHolders(devices.map((d) => ({
        serialNumber: d.serialNumber, macAddress: d.macAddress, hostName: d.hostName, user: d.assignedTo,
      }))));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const use = async (row) => {
    try {
      const r = await setAssetHolder(row.assetId, { assigneeKind: 'person', assigneeKey: row.device.login, source: 'holder-check' });
      setDone((d) => ({ ...d, [row.assetId]: r.assignedTo }));
    } catch (e) { alert(e.message); }
  };

  if (!devices?.length) return null;
  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={run} disabled={busy} style={btn}>{busy ? 'Checking…' : 'Check who uses these devices'}</button>
        <span style={muted}>Compares each device's logged-on user with its holder in FAS. Changes nothing by itself.</span>
      </div>
      {error && <div style={{ color: '#dc2626', marginTop: 8, fontSize: 13 }}>{error}</div>}
      {res && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <div style={muted}>
            {res.checked} devices: {res.matched} found in FAS ({res.same} already right
            {res.noUser ? `, ${res.noUser} with no logged-on user` : ''}
            {res.userNotInAd.length ? `, ${res.userNotInAd.length} with a user not in AD` : ''}),
            {' '}{res.unmatched.length} not in FAS yet.
          </div>
          {res.differences.length === 0 ? (
            <div style={{ marginTop: 6, color: '#166534' }}>No differences.</div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Asset</th><th style={th}>In FAS</th><th style={th}>Logged on to the device</th><th style={th} /></tr></thead>
                <tbody>
                  {res.differences.map((d) => (
                    <tr key={d.assetId}>
                      <td style={td}>{d.assetId}<div style={muted}>{d.hostName || d.brandModel} · found by {d.matchedBy}</div></td>
                      <td style={td}>{d.current.name || <span style={muted}>nobody</span>}
                        {d.current.kind === 'text' && <span style={tag}>not linked</span>}</td>
                      <td style={td}>{d.device.name}<div style={muted}>{d.device.login}{d.device.department ? ` · ${d.device.department}` : ''}</div>
                        {d.device.adminAccount && <span style={tag}>admin account</span>}
                        {d.device.disabled && <span style={tag}>disabled</span>}</td>
                      <td style={td}>
                        {done[d.assetId]
                          ? <span style={{ color: '#166534' }}>Now {done[d.assetId]}</span>
                          : <button type="button" style={btnSmall} onClick={() => use(d)}>Use {d.device.name.split(' ')[0]}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const box = { marginTop: 14, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fafafa' };
const muted = { color: '#6b7280', fontSize: 12.5 };
const btn = { padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 14 };
const btnSmall = { ...btn, padding: '4px 10px', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12.5, color: '#374151', borderBottom: '1px solid #e5e7eb' };
const td = { padding: '6px 8px', fontSize: 13, borderTop: '1px solid #f1f5f9', verticalAlign: 'top' };
const tag = { marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e', whiteSpace: 'nowrap' };
