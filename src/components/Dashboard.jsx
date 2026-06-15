// src/components/Dashboard.jsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { getAllAssets } from '../utils/api';
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, LabelList,
  PieChart, Pie, Cell,
  LineChart, Line, CartesianGrid
} from 'recharts';
import Modal from '../components/Modal';

/* ── Presentation slide definitions ── */
const SLIDE_KEYS = ['kpi', 'byGroup', 'byStatus', 'byDept', 'byType', 'byMonth', 'byCost', 'expiring', 'actions'];
const SLIDE_TITLES = {
  kpi:      'Asset Overview',
  byGroup:  'Assets by Group',
  byStatus: 'Assets by Status',
  byDept:   'Assets by Department',
  byType:   'Assets by Asset Type',
  byMonth:  'Assets Added (Last 12 Months)',
  byCost:   'Top Asset Types by Total Cost',
  expiring: 'Warranties Expiring Soon',
  actions:  'Action Items',
};

export default function Dashboard() {
  const [assets, setAssets]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [presentation, setPresentation] = useState(false);
  const [slideIdx, setSlideIdx]         = useState(0);
  const [lastUpdated, setLastUpdated]   = useState(null);

  const [drill, setDrill] = useState(null);   // { type, key, assets[] }
  const closeDrill = () => setDrill(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getAllAssets();
      setAssets(Array.isArray(data) ? data : (data?.items ?? []));
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  /* Keyboard nav in presentation mode */
  const exitPresentation = useCallback(() => setPresentation(false), []);
  useEffect(() => {
    if (!presentation) return;
    const onKey = (e) => {
      if (e.key === 'Escape')      { exitPresentation(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
        setSlideIdx(i => Math.min(SLIDE_KEYS.length - 1, i + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
        setSlideIdx(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentation, exitPresentation]);

  /* Helpers */
  const now = useMemo(() => new Date(), []);
  const toNum  = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return isFinite(n) ? n : 0; };
  const parseDate = (d) => { if (!d) return null; const dt = new Date(d); return isNaN(dt) ? null : dt; };
  const dayDiff = (a, b) => Math.ceil((a - b) / 86400000);
  const yyyymm  = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthsBack = (n) => {
    const arr = [], base = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      arr.push({ key: yyyymm(d), label: d.toLocaleString(undefined, { month: 'short' }) + ' ' + String(d.getFullYear()).slice(-2) });
    }
    return arr;
  };
  const shorten = (s, max = 14) => (s && s.length > max ? s.slice(0, max - 1) + '…' : s);

  const SERIES = ['#2563eb','#16a34a','#f59e0b','#ef4444','#0ea5e9','#8b5cf6','#22c55e','#e11d48','#64748b','#14b8a6','#f97316','#06b6d4'];
  const STATUS_COLORS = { Active: '#16a34a', 'Not active': '#ef4444', Retired: '#64748b', Suspended: '#f59e0b', Unknown: '#94a3b8' };

  const metrics = useMemo(() => {
    const total        = assets.length;
    const activeCount  = assets.filter(a => (a.status || '').toLowerCase() === 'active').length;
    const retiredCount = assets.filter(a => (a.status || '').toLowerCase() === 'retired').length;
    const unassigned   = assets.filter(a => !a.assignedTo || !String(a.assignedTo).trim());
    const missingSerial= assets.filter(a => !a.serialNumber || !String(a.serialNumber).trim());
    const percentActive= total ? (activeCount / total * 100) : 0;

    let totalValue = 0, currentValue = 0;
    assets.forEach(a => {
      const cost = toNum(a.cost), dep = toNum(a.depreciation);
      totalValue  += cost;
      currentValue += Math.max(0, cost - dep);
    });

    const ages = assets.map(a => parseDate(a.purchaseDate)).filter(Boolean)
      .map(d => (now - d) / (1000 * 60 * 60 * 24 * 365));
    const avgAgeYears = ages.length ? ages.reduce((s, v) => s + v, 0) / ages.length : 0;

    /* expired / expiring */
    const warrantied = assets
      .map(a => { const d = parseDate(a.warrantyExpiry); return d ? { ...a, _days: dayDiff(d, now) } : null; })
      .filter(Boolean);
    const expiringSoon  = warrantied.filter(a => a._days >= 0 && a._days <= 90).sort((a,b) => a._days - b._days);
    const expiredCount  = warrantied.filter(a => a._days < 0).length;

    /* charts */
    const groupMap = new Map();
    assets.forEach(a => { const k = a.group || 'Ungrouped'; groupMap.set(k, (groupMap.get(k)||0)+1); });
    const byGroup = Array.from(groupMap.entries())
      .sort((a,b) => b[1] - a[1])
      .map(([name, value], i) => ({ name, value, fill: SERIES[i % SERIES.length] }));

    const statusMap = new Map();
    assets.forEach(a => { const k = (a.status||'Unknown').trim(); statusMap.set(k, (statusMap.get(k)||0)+1); });
    const byStatus = Array.from(statusMap.entries()).map(([name, value]) => ({ name, value, fill: STATUS_COLORS[name]||STATUS_COLORS.Unknown }));

    const deptMap = new Map();
    assets.forEach(a => { const k = a.department || 'Unassigned'; deptMap.set(k, (deptMap.get(k)||0)+1); });
    const byDept = Array.from(deptMap.entries())
      .sort((a,b) => b[1] - a[1]).slice(0, 12)
      .map(([name, value], i) => ({ name, value, fill: SERIES[i % SERIES.length] }));

    const typeMap = new Map();
    assets.forEach(a => { const k = a.assetType || 'Unknown'; typeMap.set(k, (typeMap.get(k)||0)+1); });
    const byType = Array.from(typeMap.entries())
      .sort((a,b) => b[1] - a[1]).slice(0, 10)
      .map(([name, value], i) => ({ name, value, fill: SERIES[i % SERIES.length] }));

    const last12 = monthsBack(12);
    const monthCounts = Object.fromEntries(last12.map(m => [m.key, 0]));
    assets.forEach(a => {
      const d = parseDate(a.purchaseDate || a.createdAt);
      if (!d) return;
      const key = yyyymm(d);
      if (key in monthCounts) monthCounts[key] += 1;
    });
    const byMonth = last12.map((m, i) => ({ idx: i, month: m.label, count: monthCounts[m.key] }));

    const typeCost = new Map();
    assets.forEach(a => { const t = a.assetType||'Unknown'; typeCost.set(t, (typeCost.get(t)||0)+toNum(a.cost)); });
    const topTypesByCost = Array.from(typeCost.entries())
      .sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([name,value],i) => ({ name, value, fill: SERIES[i%SERIES.length] }));

    return {
      total, activeCount, retiredCount, unassigned, missingSerial,
      percentActive, totalValue, currentValue, avgAgeYears,
      expiringSoon, expiredCount,
      byGroup, byStatus, byDept, byType, byMonth, topTypesByCost
    };
  }, [assets, now]); // eslint-disable-line react-hooks/exhaustive-deps

  /* drill-down summary */
  const drillSummary = useMemo(() => {
    if (!drill) return null;
    const list = drill.assets;
    const sumCost = list.reduce((s,a) => s + toNum(a.cost), 0);
    const avgAge  = list.map(a => parseDate(a.purchaseDate)).filter(Boolean)
      .map(d => (now - d) / (1000*60*60*24*365))
      .reduce((s,v,_,arr) => s + v / arr.length, 0);
    const typeCount = {};
    list.forEach(a => { const t = a.assetType||'Unknown'; typeCount[t] = (typeCount[t]||0)+1; });
    const topTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,value])=>({name,value}));
    const deptCount = {};
    list.forEach(a => { const d = a.department||'—'; deptCount[d] = (deptCount[d]||0)+1; });
    const topDepts = Object.entries(deptCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,value])=>({name,value}));
    return { list, sumCost, avgAge, topTypes, topDepts };
  }, [drill, now]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ padding: 16 }}>Loading dashboard…</div>;

  const { total, activeCount, retiredCount, unassigned, missingSerial,
          percentActive, totalValue, currentValue, avgAgeYears,
          expiringSoon, expiredCount,
          byGroup, byStatus, byDept, byType, byMonth, topTypesByCost } = metrics;

  /* ─── Presentation mode overlay ─── */
  if (presentation) {
    const slideKey = SLIDE_KEYS[slideIdx];
    return (
      <div style={presOverlay}>
        {/* Header bar */}
        <div style={presHeader}>
          <div style={{ fontWeight: 800, fontSize: 22, color: '#fff' }}>
            {SLIDE_TITLES[slideKey]}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>
              Slide {slideIdx + 1} / {SLIDE_KEYS.length}
            </span>
            <button onClick={() => setSlideIdx(i => Math.max(0, i-1))} disabled={slideIdx === 0} style={presNavBtn}>← Prev</button>
            <button onClick={() => setSlideIdx(i => Math.min(SLIDE_KEYS.length-1, i+1))} disabled={slideIdx === SLIDE_KEYS.length-1} style={presNavBtn}>Next →</button>
            <button onClick={exitPresentation} style={{ ...presNavBtn, background: '#ef4444', borderColor: '#ef4444' }}>✕ Exit</button>
          </div>
        </div>

        {/* Slide content */}
        <div style={presContent}>
          {slideKey === 'kpi' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20 }}>
              <KPI title="Total Assets"      value={fmtNum(total)}                accent="#2563eb" big />
              <KPI title="Active"            value={fmtNum(activeCount)}          accent="#16a34a" big />
              <KPI title="% Active"          value={`${percentActive.toFixed(1)}%`} accent="#22c55e" big />
              <KPI title="Retired"           value={fmtNum(retiredCount)}         accent="#64748b" big />
              <KPI title="Unassigned"        value={fmtNum(unassigned.length)}    accent="#f59e0b" big />
              <KPI title="Missing Serials"   value={fmtNum(missingSerial.length)} accent="#94a3b8" big />
              <KPI title="Expiring ≤90d"     value={fmtNum(expiringSoon.length)}  accent="#ef4444" big />
              <KPI title="Total Value"       value={fmtBD(totalValue)}            accent="#0ea5e9" big />
              <KPI title="Est. Current Value"value={fmtBD(currentValue)}          accent="#8b5cf6" big />
              <KPI title="Avg Asset Age"     value={`${avgAgeYears.toFixed(1)} yrs`} accent="#14b8a6" big />
            </div>
          )}
          {slideKey === 'byGroup' && (
            <FullChart><PresBar data={byGroup} onBarClick={(name) => setDrill({ type: 'group', key: name, assets: assets.filter(a=>(a.group||'Ungrouped')===name) })} /></FullChart>
          )}
          {slideKey === 'byStatus' && (
            <FullChart>
              <ResponsiveContainer>
                <PieChart>
                  <Tooltip />
                  <Pie dataKey="value" data={byStatus} nameKey="name" outerRadius={180} label={(d) => `${d.name} (${d.value})`}>
                    {byStatus.map((d,i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setDrill({ type: 'status', key: d.name, assets: assets.filter(a=>(a.status||'Unknown').trim()===d.name) })} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </FullChart>
          )}
          {slideKey === 'byDept' && (
            <FullChart><PresBar data={byDept} onBarClick={(name) => setDrill({ type: 'department', key: name, assets: assets.filter(a=>(a.department||'Unassigned')===name) })} /></FullChart>
          )}
          {slideKey === 'byType' && (
            <FullChart><PresBar data={byType} onBarClick={(name) => setDrill({ type: 'type', key: name, assets: assets.filter(a=>(a.assetType||'Unknown')===name) })} /></FullChart>
          )}
          {slideKey === 'byMonth' && (
            <FullChart>
              <ResponsiveContainer>
                <LineChart data={byMonth} margin={{ top: 20, right: 30, left: 0, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fontSize: 16 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 14 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" name="New Assets" dot strokeWidth={3} activeDot={{ r: 8 }} />
                </LineChart>
              </ResponsiveContainer>
            </FullChart>
          )}
          {slideKey === 'byCost' && (
            <FullChart>
              <ResponsiveContainer>
                <BarChart data={topTypesByCost} margin={{ top: 20, right: 20, left: 20, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" interval={0} angle={-20} textAnchor="end" height={70} tick={{ fontSize: 15 }} tickFormatter={v => shorten(v, 20)} />
                  <YAxis tickFormatter={v => fmtBD(v)} tick={{ fontSize: 13 }} />
                  <Tooltip formatter={v => fmtBD(v)} />
                  <Bar dataKey="value" name="Total Cost" radius={[6,6,0,0]}>
                    <LabelList dataKey="value" position="top" formatter={v => fmtBD(v)} style={{ fontSize: 13, fontWeight: 700 }} />
                    {topTypesByCost.map((d,i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </FullChart>
          )}
          {slideKey === 'expiring' && (
            <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 160px)', background: '#fff', borderRadius: 12, padding: 16 }}>
              {expiringSoon.length === 0 ? (
                <div style={{ textAlign: 'center', fontSize: 24, color: '#16a34a', padding: 40 }}>✓ All Clear — No warranties expiring in 90 days</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#f3f4f6' }}>
                    <tr>
                      {['Asset ID','Group','Type','Warranty Expiry','Days Left','Assigned To'].map(h => (
                        <th key={h} style={{ padding: '14px 12px', fontSize: 16, fontWeight: 700, textAlign: 'left', borderBottom: '2px solid #e5e7eb' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {expiringSoon.map(a => (
                      <tr key={a.assetId} style={{ borderBottom: '1px solid #eee', background: a._days <= 14 ? '#fff1f2' : 'transparent' }}>
                        <td style={{ padding: '12px', fontSize: 15 }}>{a.assetId}</td>
                        <td style={{ padding: '12px', fontSize: 15 }}>{a.group||'-'}</td>
                        <td style={{ padding: '12px', fontSize: 15 }}>{a.assetType||'-'}</td>
                        <td style={{ padding: '12px', fontSize: 15 }}>{a.warrantyExpiry||'-'}</td>
                        <td style={{ padding: '12px', fontSize: 15, fontWeight: a._days<=14 ? 800 : 400, color: a._days<=14 ? '#b91c1c' : a._days<=30 ? '#d97706' : '#111' }}>{a._days}d</td>
                        <td style={{ padding: '12px', fontSize: 15 }}>{a.assignedTo||'-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {slideKey === 'actions' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
              <ActionCard count={expiringSoon.length} label="Warranties expiring ≤ 90 days" color="#ef4444" icon="⚠️" onClick={() => setDrill({ type: 'expiring', key: 'Expiring', assets: expiringSoon })} />
              <ActionCard count={expiredCount}        label="Warranties already expired"     color="#b91c1c" icon="🔴" onClick={() => setDrill({ type: 'expiring', key: 'Expired', assets: assets.filter(a=>{ const d=parseDate(a.warrantyExpiry); return d && dayDiff(d,now)<0; }) })} />
              <ActionCard count={unassigned.length}   label="Unassigned assets"              color="#f59e0b" icon="👤" onClick={() => setDrill({ type: 'unassigned', key: 'Unassigned', assets: unassigned })} />
              <ActionCard count={missingSerial.length}label="Assets missing serial numbers"  color="#64748b" icon="🔖" onClick={() => setDrill({ type: 'missing', key: 'Missing Serial', assets: missingSerial })} />
            </div>
          )}
        </div>

        {/* Slide dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '10px 0' }}>
          {SLIDE_KEYS.map((k, i) => (
            <button key={k} onClick={() => setSlideIdx(i)} style={{ width: 10, height: 10, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0, background: i === slideIdx ? '#fff' : 'rgba(255,255,255,0.35)' }} aria-label={SLIDE_TITLES[k]} />
          ))}
        </div>

        {/* Drill-down modal inside presentation */}
        <DrillModal drill={drill} summary={drillSummary} onClose={closeDrill} toNum={toNum} />
      </div>
    );
  }

  /* ─── Normal mode ─── */
  return (
    <div style={{ display: 'grid', gap: 16 }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>Asset Overview</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <small style={{ color: '#6b7280' }}>Updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}</small>
          <button onClick={load} style={btn('neutral')}>↻ Refresh</button>
          <button onClick={() => { setSlideIdx(0); setPresentation(true); }} style={btn('primary')}>▶ Presentation Mode</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KPI title="Total Assets"       value={fmtNum(total)}                 accent="#2563eb" />
        <KPI title="Active"             value={fmtNum(activeCount)}           accent="#16a34a" />
        <KPI title="% Active"           value={`${percentActive.toFixed(1)}%`} accent="#22c55e" />
        <KPI title="Retired"            value={fmtNum(retiredCount)}          accent="#64748b" />
        <KPI title="Unassigned"         value={fmtNum(unassigned.length)}     accent="#f59e0b" />
        <KPI title="Expiring ≤90d"      value={fmtNum(expiringSoon.length)}   accent="#ef4444" />
        <KPI title="Total Value"        value={fmtBD(totalValue)}             accent="#0ea5e9" />
        <KPI title="Est. Current Value" value={fmtBD(currentValue)}           accent="#8b5cf6" />
        <KPI title="Avg Age"            value={`${avgAgeYears.toFixed(1)} yrs`} accent="#14b8a6" />
      </div>

      {/* Action items */}
      <Card title="Action Items">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <ActionCard count={expiringSoon.length} label="Warranties expiring ≤ 90 days" color="#ef4444" icon="⚠️"
            onClick={() => setDrill({ type: 'expiring', key: 'Expiring ≤90d', assets: expiringSoon })} />
          <ActionCard count={expiredCount}        label="Warranties already expired"    color="#b91c1c" icon="🔴"
            onClick={() => setDrill({ type: 'expiring', key: 'Expired Warranties', assets: assets.filter(a=>{ const d=parseDate(a.warrantyExpiry); return d && dayDiff(d,now)<0; }) })} />
          <ActionCard count={unassigned.length}   label="Unassigned assets"             color="#f59e0b" icon="👤"
            onClick={() => setDrill({ type: 'unassigned', key: 'Unassigned', assets: unassigned })} />
          <ActionCard count={missingSerial.length} label="Missing serial numbers"       color="#64748b" icon="🔖"
            onClick={() => setDrill({ type: 'missing', key: 'Missing Serial', assets: missingSerial })} />
        </div>
      </Card>

      {/* Charts row 1 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Assets by Group (click to drill down)">
          {byGroup.length === 0 ? <Empty>Nothing to show</Empty> : (
            <div style={{ height: 280 }}>
              <ResponsiveContainer>
                <BarChart data={byGroup} margin={{ top: 8, right: 8, left: 0, bottom: 40 }} barCategoryGap="18%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" interval={0} angle={-25} textAnchor="end" height={50} tick={{ fontSize: 12 }} tickFormatter={v => shorten(v)} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[5,5,0,0]} minPointSize={1}>
                    <LabelList dataKey="value" position="top" style={{ fontWeight: 700, fontSize: 11 }} />
                    {byGroup.map((d,i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setDrill({ type: 'group', key: d.name, assets: assets.filter(a=>(a.group||'Ungrouped')===d.name) })} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Assets by Status (click to drill down)">
          {byStatus.length === 0 ? <Empty>Nothing to show</Empty> : (
            <div style={{ height: 280 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Tooltip />
                  <Pie dataKey="value" data={byStatus} nameKey="name" outerRadius={100} label={d => `${d.name} (${d.value})`}>
                    {byStatus.map((d,i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setDrill({ type: 'status', key: d.name, assets: assets.filter(a=>(a.status||'Unknown').trim()===d.name) })} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Charts row 2 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Assets by Department (click to drill down)">
          {byDept.length === 0 ? <Empty>Nothing to show</Empty> : (
            <div style={{ height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={byDept} layout="vertical" margin={{ top: 4, right: 50, left: 80, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} tickFormatter={v => shorten(v, 16)} width={80} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0,5,5,0]} minPointSize={2}>
                    <LabelList dataKey="value" position="right" style={{ fontWeight: 700, fontSize: 11 }} />
                    {byDept.map((d,i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setDrill({ type: 'department', key: d.name, assets: assets.filter(a=>(a.department||'Unassigned')===d.name) })} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Assets by Type (click to drill down)">
          {byType.length === 0 ? <Empty>Nothing to show</Empty> : (
            <div style={{ height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={byType} layout="vertical" margin={{ top: 4, right: 50, left: 80, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} tickFormatter={v => shorten(v, 16)} width={80} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0,5,5,0]} minPointSize={2}>
                    <LabelList dataKey="value" position="right" style={{ fontWeight: 700, fontSize: 11 }} />
                    {byType.map((d,i) => <Cell key={i} fill={d.fill} style={{ cursor: 'pointer' }} onClick={() => setDrill({ type: 'type', key: d.name, assets: assets.filter(a=>(a.assetType||'Unknown')===d.name) })} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Charts row 3 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Assets Added (last 12 months)">
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={byMonth} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="count" name="New Assets" dot activeDot={{ r: 6 }} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Top 5 Asset Types by Total Cost">
          {topTypesByCost.length === 0 ? <Empty>Nothing to show</Empty> : (
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={topTypesByCost} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" interval={0} angle={-20} textAnchor="end" height={60} tickFormatter={v => shorten(v)} />
                  <YAxis tickFormatter={v => fmtBD(v)} />
                  <Tooltip formatter={v => fmtBD(v)} />
                  <Bar dataKey="value" name="Total Cost" radius={[5,5,0,0]}>
                    <LabelList dataKey="value" position="top" formatter={v => fmtBD(v)} style={{ fontSize: 11, fontWeight: 700 }} />
                    {topTypesByCost.map((d,i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Expiring soon */}
      <Card title="Warranties Expiring Soon (next 90 days)">
        {expiringSoon.length === 0 ? <Empty>✓ All clear — no warranties expiring in the next 90 days</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: '#f3f4f6' }}>
                <tr>
                  {['Asset ID','Group','Type','Warranty Expiry','Days Left','Assigned To'].map(h => (
                    <th key={h} style={th(false)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expiringSoon.map(a => (
                  <tr key={a.assetId} style={{ borderBottom: '1px solid #eee', background: a._days <= 14 ? '#fff1f2' : 'transparent' }}>
                    <td style={td(false)}>{a.assetId}</td>
                    <td style={td(false)}>{a.group||'-'}</td>
                    <td style={td(false)}>{a.assetType||'-'}</td>
                    <td style={td(false)}>{a.warrantyExpiry||'-'}</td>
                    <td style={{ ...td(false), fontWeight: a._days<=14?700:400, color: a._days<=14?'#b91c1c': a._days<=30?'#d97706':undefined }}>{a._days}d</td>
                    <td style={td(false)}>{a.assignedTo||'-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Drill-down modal */}
      <DrillModal drill={drill} summary={drillSummary} onClose={closeDrill} toNum={toNum} />
    </div>
  );
}

/* ── Drill-down modal ── */
function DrillModal({ drill, summary, onClose, toNum }) {
  if (!drill || !summary) return null;
  const { list, sumCost, avgAge, topTypes, topDepts } = summary;
  const title = drill.key;
  return (
    <Modal isOpen={true} onClose={onClose}>
      <h3 style={{ marginTop: 0, marginRight: 32 }}>{title} — {list.length} asset{list.length !== 1 ? 's' : ''}</h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <MiniStat label="Total Cost"  value={fmtBD(sumCost)} />
        <MiniStat label="Avg Age"     value={`${avgAge.toFixed(1)} yrs`} />
        <MiniStat label="Asset Count" value={list.length} />
      </div>

      {topTypes.length > 0 && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 6, marginTop: 12 }}>By Asset Type</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {topTypes.map(t => (
              <span key={t.name} style={{ background: '#f3f4f6', borderRadius: 6, padding: '3px 10px', fontSize: 13 }}>
                {t.name} <strong>{t.value}</strong>
              </span>
            ))}
          </div>
        </>
      )}

      {topDepts.length > 0 && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>By Department</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {topDepts.map(d => (
              <span key={d.name} style={{ background: '#eff6ff', borderRadius: 6, padding: '3px 10px', fontSize: 13 }}>
                {d.name} <strong>{d.value}</strong>
              </span>
            ))}
          </div>
        </>
      )}

      <div style={{ fontWeight: 600, marginBottom: 6 }}>All Assets ({list.length})</div>
      <div style={{ overflowY: 'auto', maxHeight: 340, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f3f4f6', position: 'sticky', top: 0 }}>
            <tr>
              {['Asset ID','Type','Brand','Model','Status','Department','Assigned To','Cost'].map(h => (
                <th key={h} style={{ padding: '8px 10px', fontSize: 13, fontWeight: 700, textAlign: 'left', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((a) => {
              const bm = (a.brandModel||'').trim();
              const spIdx = bm.indexOf(' ');
              const brand = spIdx > -1 ? bm.slice(0, spIdx) : bm;
              const model = spIdx > -1 ? bm.slice(spIdx+1) : '';
              return (
                <tr key={a.assetId || Math.random()} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={tdS}>{a.assetId||'-'}</td>
                  <td style={tdS}>{a.assetType||'-'}</td>
                  <td style={tdS}>{brand||'-'}</td>
                  <td style={tdS}>{model||'-'}</td>
                  <td style={tdS}>{a.status||'-'}</td>
                  <td style={tdS}>{a.department||'-'}</td>
                  <td style={tdS}>{a.assignedTo||'-'}</td>
                  <td style={tdS}>{toNum(a.cost) ? fmtBD(toNum(a.cost)) : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/* ── Reusable chart for presentation slides ── */
function PresBar({ data, onBarClick }) {
  const shorten = (s, max = 18) => (s && s.length > max ? s.slice(0, max-1)+'…' : s);
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={{ top: 20, right: 30, left: 10, bottom: 70 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="name" interval={0} angle={-25} textAnchor="end" height={80} tick={{ fontSize: 16 }} tickFormatter={v => shorten(v)} />
        <YAxis allowDecimals={false} tick={{ fontSize: 14 }} />
        <Tooltip />
        <Bar dataKey="value" radius={[6,6,0,0]} minPointSize={2}>
          <LabelList dataKey="value" position="top" style={{ fontWeight: 800, fontSize: 16 }} />
          {data.map((d,i) => (
            <Cell key={i} fill={d.fill} style={{ cursor: onBarClick ? 'pointer' : 'default' }}
              onClick={() => onBarClick && onBarClick(d.name)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function FullChart({ children }) {
  return <div style={{ width: '100%', height: 'calc(100vh - 200px)', minHeight: 300 }}>{children}</div>;
}

/* ── Small atoms ── */
function KPI({ title, value, accent = '#2563eb', big = false }) {
  return (
    <div style={{ background: `linear-gradient(180deg,${hexA(accent,0.08)} 0%,#fff 100%)`, border: `1px solid ${hexA(accent,0.25)}`, borderRadius: 12, padding: big ? 20 : 14, boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }}>
      <div style={{ fontSize: big ? 14 : 12, color: '#6b7280', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: big ? 34 : 26, fontWeight: 800, color: '#0f172a' }}>{value}</div>
    </div>
  );
}

function ActionCard({ count, label, color, icon, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, background: `${color}10`, border: `1px solid ${color}40`, borderRadius: 10, padding: '12px 16px', cursor: count > 0 ? 'pointer' : 'default', textAlign: 'left', width: '100%' }}>
      <span style={{ fontSize: 24 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 28, fontWeight: 800, color: count > 0 ? color : '#16a34a', lineHeight: 1.1 }}>{count}</div>
        <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>{label}</div>
      </div>
    </button>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.04)' }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ color: '#6b7280', fontStyle: 'italic', padding: '8px 0' }}>{children}</div>;
}

/* ── Styles ── */
const presOverlay = { position: 'fixed', inset: 0, background: '#0f172a', display: 'flex', flexDirection: 'column', zIndex: 2000, color: '#fff' };
const presHeader  = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: 'rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.1)' };
const presContent = { flex: 1, overflowY: 'auto', padding: 24 };
const presNavBtn  = { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.3)', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 14 };

const th  = (big) => ({ textAlign: 'left', padding: big ? '12px' : '8px 10px', fontSize: big ? 14 : 13, borderBottom: '1px solid #e5e7eb', fontWeight: 700 });
const td  = (big) => ({ padding: big ? '10px 12px' : '8px 10px', fontSize: big ? 14 : 13 });
const tdS = { padding: '7px 10px', fontSize: 12 };

function fmtNum(n) { return Math.round(n).toLocaleString(); }
function fmtBD(v) {
  return `BD ${new Intl.NumberFormat('en-BH', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(v||0))}`;
}
function hexA(hex, alpha = 0.2) {
  const c = hex.replace('#','');
  return `rgba(${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)},${alpha})`;
}
function btn(variant) {
  const base = { cursor: 'pointer', border: '1px solid transparent', padding: '8px 14px', borderRadius: 8, fontSize: 13 };
  return variant === 'primary' ? { ...base, background: '#2563eb', color: '#fff' } : { ...base, background: '#f3f4f6', color: '#111827' };
}
