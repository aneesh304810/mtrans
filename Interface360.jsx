import React, { useState, useEffect, useMemo } from 'react';
import { SectionHeader } from './AppShell.jsx';
import GraphFilterBar from './GraphFilterBar.jsx';
import { interface360Filters } from './filterConfigs.js';
import ProjectBadge from './ProjectBadge.jsx';
import PiiBadge from './PiiBadge.jsx';
import { api } from './api.js';

export default function Interface360({ t, selection }) {
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [facets, setFacets] = useState({});
  const [values, setValues] = useState({});
  const [view, setView] = useState('Table');
  const [tableQ, setTableQ] = useState('');
  const [sel, setSel] = useState(null);

  // Fetch ONCE, unfiltered — all 800+ interfaces live in the client; every
  // filter and the table search then operate over the full set.
  useEffect(() => {
    api.interfaceStats().then(setStats);
    api.interfaceFacets().then(setFacets);
    api.interfaces().then(d => setRows(d.interfaces || []));
  }, []);

  // Generic client-side filtering: EVERY facet key the filter bar collects is
  // applied (multi-select = OR within a facet, AND across facets). Previously
  // only source_project_id / target_project_id / feed_type reached the API,
  // and only their first value — every other selection was silently ignored.
  const filtered = useMemo(() => rows.filter(r =>
    Object.entries(values).every(([k, selVals]) =>
      !selVals || selVals.length === 0 ||
      selVals.includes(r[k]) ||
      selVals.includes(String(r[k] ?? '')))
  ), [rows, values]);

  // Cascading facets: each dropdown only offers values that co-occur with the
  // OTHER facets' current selections (classic faceted search — a facet never
  // narrows itself, so multi-select within it stays possible). Options that
  // would yield zero rows disappear; currently-selected values always remain
  // so they can be unselected. Entry shape ({value}/{name}/{label}/string) and
  // counts are preserved; facet keys that aren't row fields pass through.
  const facetValue = (e) => (e && typeof e === 'object') ? (e.value ?? e.name ?? e.label) : e;
  const dynamicFacets = useMemo(() => {
    if (!rows.length) return facets;
    const out = { ...facets };
    for (const [k, list] of Object.entries(facets)) {
      if (!Array.isArray(list)) continue;
      if (!rows.some(r => k in r)) continue;              // config keys, not row fields
      const others = Object.entries(values)
        .filter(([vk, selVals]) => vk !== k && selVals && selVals.length);
      const base = rows.filter(r => others.every(([vk, selVals]) =>
        selVals.includes(r[vk]) || selVals.includes(String(r[vk] ?? ''))));
      const allowed = new Set();
      base.forEach(r => { allowed.add(r[k]); allowed.add(String(r[k] ?? '')); });
      (values[k] || []).forEach(v => allowed.add(v));
      const counts = {};
      base.forEach(r => { counts[r[k]] = (counts[r[k]] || 0) + 1; });
      out[k] = list
        .filter(e => allowed.has(facetValue(e)))
        .map(e => (e && typeof e === 'object' && 'count' in e)
          ? { ...e, count: counts[facetValue(e)] || 0 } : e);
    }
    return out;
  }, [facets, rows, values]);

  const cfg = useMemo(() => interface360Filters(dynamicFacets), [dynamicFacets]);
  const kpi = (n, l, tone) => (
    <div style={{ background: t.panel, border: `1px solid ${t.disabled}`, borderRadius: t.radius.md,
      padding: '15px 20px', minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1,
        color: tone === 'warn' ? t.warning : tone === 'danger' ? t.danger : t.navy }}>{n}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.5px', color: t.textMuted, marginTop: 4 }}>{l}</div>
    </div>
  );

  return (
    <div>
      <SectionHeader t={t}>Interface 360</SectionHeader>
      <div style={{ display: 'flex', gap: 15, marginBottom: 30, flexWrap: 'wrap' }}>
        {kpi(stats?.interfaces ?? '\u2014', 'Interfaces')}
        {kpi(stats?.systems ?? '\u2014', 'Systems')}
        {kpi(stats?.migration ?? '\u2014', '\u26A0 Replace', 'warn')}
        {kpi(stats?.carry_pii ?? '\u2014', '\u{1F512} Carry PII', 'danger')}
        {kpi(stats?.cross_project ?? '\u2014', 'SEI \u2194 Non-SEI', 'warn')}
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: `1px solid ${t.disabled}` }}>
        {['Table', 'Matrix', 'Routing Paths', 'Explorer'].map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            background: 'none', border: 'none', fontFamily: t.font, fontSize: 13, fontWeight: 500,
            padding: '10px 18px', cursor: 'pointer', marginBottom: -1,
            color: view === v ? t.accent : t.sub,
            borderBottom: `2px solid ${view === v ? t.accent : 'transparent'}` }}>{v}</button>
        ))}
      </div>

      <GraphFilterBar moduleKey="interface360" required={cfg.required} optional={cfg.optional}
        values={values} onChange={setValues} onClear={() => setValues({})}
        resultCount={filtered.length} totalCount={stats?.interfaces || rows.length}
        nodeCount={stats?.systems || 0} densityThreshold={cfg.densityThreshold}
        alternativeView={cfg.alternativeView} onSwitchView={setView} t={t} />

      {view === 'Table' && (
        <>
          <input value={tableQ} onChange={(e) => setTableQ(e.target.value)}
            placeholder="Search interfaces (source, target, integration, owner)…"
            style={{ width: '100%', maxWidth: 460, padding: '9px 13px', fontSize: 13,
              fontFamily: t.font, border: `1px solid ${t.disabled}`, borderRadius: t.radius.sm,
              marginBottom: 12 }} />
          <table style={{ width: '100%', borderCollapse: 'collapse', background: t.panel,
            border: `1px solid ${t.disabled}`, borderRadius: t.radius.md, overflow: 'hidden' }}>
            <thead><tr>{['Source', 'Project', '', 'Target', 'Project', 'Integration', 'Type',
              'Frequency', 'Migration', 'PII', 'Owner'].map((h, i) => (
              <th key={i} style={thStyle(t)}>{h}</th>))}</tr></thead>
            <tbody>
              {filtered.filter(r => {
                if (!tableQ.trim()) return true;
                const s = tableQ.toLowerCase();
                return [r.source_system, r.target_system, r.integration_name, r.update_owner,
                  r.feed_type].some(v => (v || '').toLowerCase().includes(s));
              }).map(r => (
                <tr key={r.interface_id} onClick={() => setSel(r)} style={{ cursor: 'pointer' }}>
                  <td style={tdStyle(t)}><b>{r.source_system}</b></td>
                  <td style={tdStyle(t)}><ProjectBadge projectId={r.source_project_id} t={t} /></td>
                  <td style={{ ...tdStyle(t), color: t.accent, fontWeight: 700 }}>{'\u25B6'}</td>
                  <td style={tdStyle(t)}><b>{r.target_system}</b></td>
                  <td style={tdStyle(t)}><ProjectBadge projectId={r.target_project_id} t={t} /></td>
                  <td style={tdStyle(t)}>{r.integration_name}</td>
                  <td style={tdStyle(t)}><span style={chipStyle(t)}>{r.feed_type}</span></td>
                  <td style={tdStyle(t)}>{r.frequency}</td>
                  <td style={tdStyle(t)}>{r.migration_flag === 'Y' &&
                    <span style={migStyle(t)}>Replace</span>}</td>
                  <td style={tdStyle(t)}>{r.carries_pii === 'Y' &&
                    <PiiBadge category={r.pii_categories} t={t} />}</td>
                  <td style={tdStyle(t)}>{r.update_owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {view === 'Matrix' && <MatrixView t={t} rows={filtered} />}
      {view === 'Routing Paths' && <RoutingView t={t} rows={filtered} />}
      {view === 'Explorer' && <ExplorerView t={t} rows={filtered} />}

      {sel && <Drawer t={t} r={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function MatrixView({ t, rows }) {
  const systems = [...new Set(rows.flatMap(r => [r.source_system, r.target_system]))].slice(0, 12);
  const cell = {};
  for (const r of rows) cell[`${r.source_system}|${r.target_system}`] =
    (cell[`${r.source_system}|${r.target_system}`] || 0) + 1;
  const max = Math.max(1, ...Object.values(cell));
  return (
    <div style={{ overflow: 'auto', background: t.panel, border: `1px solid ${t.disabled}`,
      borderRadius: t.radius.md, padding: 20 }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead><tr><th style={{ ...thStyle(t), position: 'sticky', left: 0 }}>Source \ Target</th>
          {systems.map(s => <th key={s} style={{ ...thStyle(t), writingMode: 'vertical-rl',
            height: 90, fontSize: 10 }}>{s}</th>)}</tr></thead>
        <tbody>
          {systems.map(src => (
            <tr key={src}><td style={{ ...tdStyle(t), fontWeight: 600, whiteSpace: 'nowrap' }}>{src}</td>
              {systems.map(tg => {
                const n = cell[`${src}|${tg}`] || 0;
                const op = n / max;
                return <td key={tg} title={`${src} \u2192 ${tg}: ${n}`} style={{
                  width: 38, height: 34, textAlign: 'center', fontSize: 11, fontWeight: 600,
                  color: op > 0.5 ? '#fff' : t.text,
                  background: n ? `rgba(15,71,117,${0.2 + op * 0.8})` : t.panel2,
                  border: `1px solid ${t.panel}` }}>{n || ''}</td>;
              })}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoutingView({ t, rows }) {
  const [q, setQ] = React.useState('');

  // classify routes: multi-hop (via warehouse), legacy (AddVantage source), simple
  const isWarehouse = (s) => /PBDW|warehouse|IMDW|datamart|data warehouse/i.test(s || '');
  const isLegacy = (s) => /addvantage|legacy|star|advent/i.test(s || '');

  const filtered = rows.filter(r => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [r.source_system, r.target_system, r.integration_name, r.feed_routing]
      .some(v => (v || '').toLowerCase().includes(s));
  });

  const multiHop = filtered.filter(r => isWarehouse(r.feed_routing) || isWarehouse(r.target_system)).slice(0, 8);
  const legacy = filtered.filter(r => isLegacy(r.source_system)).slice(0, 8);
  const simple = filtered.filter(r => !isWarehouse(r.feed_routing) && !isWarehouse(r.target_system)
    && !isLegacy(r.source_system)).slice(0, 8);

  const chainCard = (r, kind) => {
    const hops = kind === 'multi'
      ? [{ n: r.source_system, s: 'source' }, { n: 'PBDW', s: 'warehouse \u00b7 gold mart', mid: true }, { n: r.target_system, s: 'target' }]
      : [{ n: r.source_system, s: kind === 'legacy' ? 'legacy \u00b7 being retired' : 'source \u00b7 target platform' },
        { n: r.target_system, s: 'target' }];
    const col = kind === 'legacy' ? '#5a6472' : kind === 'multi' ? '#0f4775' : (t.accent || '#0091bf');
    return (
      <div key={r.interface_id} style={{ background: t.panel, border: `1px solid ${t.disabled}`,
        borderRadius: t.radius.md, padding: 16, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.sub, marginBottom: 10 }}>{r.integration_name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {hops.map((h, i) => (
            <React.Fragment key={i}>
              <div style={{ background: h.mid ? '#10193b' : col, color: '#fff', borderRadius: 6,
                padding: '8px 14px', minWidth: 90 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{h.n}</div>
                <div style={{ fontSize: 9, opacity: 0.85 }}>{h.s}</div>
              </div>
              {i < hops.length - 1 && <span style={{ color: t.muted, fontSize: 18 }}>{'\u2192'}</span>}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  const section = (title, list, kind) => list.length > 0 && (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
        color: t.muted || t.textMuted, marginBottom: 10 }}>{title}</div>
      {list.map(r => chainCard(r, kind))}
    </div>
  );

  return (
    <div>
      {/* search on top */}
      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search routes (source, target, integration)…"
        style={{ width: '100%', maxWidth: 460, padding: '9px 13px', fontSize: 13, fontFamily: t.font,
          border: `1px solid ${t.disabled}`, borderRadius: t.radius.sm, marginBottom: 18 }} />

      {section('Simple route \u2014 default chain', simple, 'simple')}
      {section('Complex multi-hop \u2014 via warehouse (PBDW)', multiHop, 'multi')}
      {section('Legacy (reference) \u2014 what this replaces', legacy, 'legacy')}

      {/* migration gaps callout */}
      <div style={{ background: t.warnbg || '#fff7e6', border: `1px solid ${t.warn || '#e0b050'}`,
        borderRadius: t.radius.md, padding: 14, marginTop: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: t.navy, marginBottom: 4 }}>Migration gaps</div>
        <div style={{ fontSize: 12, color: t.sub }}>
          {'\u26a0'} Interfaces whose AddVantage source has no matched SEI target
          ({legacy.length} legacy routes shown) — work still to do.</div>
      </div>
    </div>
  );
}

function ExplorerView({ t, rows }) {
  // Build source -> integration -> target -> interface index from live rows.
  const [source, setSource] = React.useState(null);
  const [integration, setIntegration] = React.useState(null);
  const [target, setTarget] = React.useState(null);

  const sources = React.useMemo(() => {
    const m = {};
    for (const r of rows) {
      const s = r.source_system || 'Unknown';
      m[s] = (m[s] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const integrations = React.useMemo(() => {
    if (!source) return [];
    const m = {};
    for (const r of rows) {
      if ((r.source_system || 'Unknown') !== source) continue;
      const i = r.integration_name || r.integration || '(direct)';
      m[i] = (m[i] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows, source]);

  const targets = React.useMemo(() => {
    if (!source || !integration) return [];
    const m = {};
    for (const r of rows) {
      if ((r.source_system || 'Unknown') !== source) continue;
      if ((r.integration_name || r.integration || '(direct)') !== integration) continue;
      const tg = r.target_system || 'Unknown';
      if (!m[tg]) m[tg] = r;
    }
    return Object.entries(m);
  }, [rows, source, integration]);

  const detail = target ? targets.find(([tg]) => tg === target)?.[1] : null;

  const col = { minWidth: 200, padding: '0 12px', display: 'flex', flexDirection: 'column' };
  const colTitle = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.5px', color: t.textMuted, marginBottom: 12 };
  const node = (key, label, sub, active, onClick, tone) => (
    <button key={key} onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', textAlign: 'left', width: '100%',
      background: tone === 'legacy' ? t.nonsei || '#7a7f87' : tone === 'target' ? t.accent : (t.sei || t.navy),
      color: '#fff', border: `2px solid ${active ? (t.gold || '#d4a02a') : 'transparent'}`,
      boxShadow: active ? `0 0 0 3px rgba(212,160,42,0.25)` : 'none',
      borderRadius: 9, padding: '11px 14px', marginBottom: 10, cursor: 'pointer',
      fontFamily: t.font }}>
      <b style={{ fontSize: 13 }}>{label}</b>
      <span style={{ fontSize: 10, opacity: 0.82, marginTop: 2 }}>{sub}</span>
    </button>
  );

  const hint = !source ? 'Start by selecting a source system.'
    : !integration ? `Source: ${source} \u2014 pick an integration.`
    : !target ? `Integration: ${integration} \u2014 pick a target system.`
    : `Full path: ${source} \u2192 ${integration} \u2192 ${target}`;

  return (
    <div>
      <div style={{ fontSize: 13, color: t.sub, marginBottom: 14 }}>
        Pick a source system, then drill down one hop at a time. Columns appear only as you select \u2014 no clutter.
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto',
        padding: '18px 6px', minHeight: 320, background: t.panel,
        border: `1px solid ${t.disabled}`, borderRadius: t.radius.md }}>

        <div style={col}>
          <div style={colTitle}>1 \u00b7 Source system</div>
          {sources.map(([s, n]) => node(s, s, `${n} interface${n > 1 ? 's' : ''}`,
            source === s, () => { setSource(s); setIntegration(null); setTarget(null); },
            /addvantage|legacy/i.test(s) ? 'legacy' : 'source'))}
        </div>

        {source && (
          <div style={{ ...col, borderLeft: `2px dashed ${t.disabled}` }}>
            <div style={colTitle}>2 \u00b7 Integration / feed</div>
            {integrations.map(([i, n]) => node(i, i, `${n} route${n > 1 ? 's' : ''}`,
              integration === i, () => { setIntegration(i); setTarget(null); }))}
          </div>
        )}

        {source && integration && (
          <div style={{ ...col, borderLeft: `2px dashed ${t.disabled}` }}>
            <div style={colTitle}>3 \u00b7 Target system</div>
            {targets.map(([tg, r]) => node(tg, tg,
              r.migration_flag === 'Y' ? 'target \u00b7 replacing' : 'target',
              target === tg, () => setTarget(tg), 'target'))}
          </div>
        )}

        {detail && (
          <div style={{ ...col, borderLeft: `2px dashed ${t.disabled}`, minWidth: 260 }}>
            <div style={colTitle}>4 \u00b7 Interface detail</div>
            <div style={{ background: t.panel2 || '#f7f9fa', border: `1px solid ${t.disabled}`,
              borderRadius: 9, padding: 14 }}>
              <div style={{ fontWeight: 700, color: t.navy, marginBottom: 10 }}>
                {source} \u2192 {target}</div>
              {/* multi-hop chain — if routing names an intermediate warehouse */}
              {(() => {
                const routing = detail.feed_routing || detail.routing || '';
                const hops = routing.includes('\u2192') ? routing.split('\u2192').map(h => h.trim())
                  : /PBDW|warehouse|IMDW/i.test(routing) ? [source, 'PBDW', target] : null;
                if (!hops || hops.length < 3) return null;
                return (
                  <div style={{ marginBottom: 12, padding: '10px', background: t.panel,
                    border: `1px dashed ${t.disabled}`, borderRadius: 7 }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px',
                      color: t.textMuted, marginBottom: 6 }}>Multi-hop route</div>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                      {hops.map((h, i) => (
                        <React.Fragment key={i}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#fff',
                            background: i === 0 ? (t.sei || t.navy) : i === hops.length - 1 ? t.accent : '#7c3aed',
                            padding: '3px 9px', borderRadius: 5 }}>{h}</span>
                          {i < hops.length - 1 && <span style={{ color: t.textMuted }}>{'\u2192'}</span>}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {[['Integration', integration],
                ['Routing', detail.feed_routing || detail.routing || '\u2014'],
                ['Feed Type', detail.feed_type],
                ['Direction', detail.direction],
                ['Frequency', detail.frequency],
                ['Migration', detail.migration_flag === 'Y' ? 'Replacing' : 'Stable'],
                ['Carries PII', detail.carries_pii === 'Y' ? 'Yes' : 'No'],
                ['Owner', detail.update_owner]].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: `1px solid ${t.panel}`, fontSize: 12 }}>
                  <span style={{ color: t.textMuted }}>{k}</span>
                  <b style={{ color: t.navy }}>{v || '\u2014'}</b>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, padding: '10px 6px 0' }}>{hint}</div>
    </div>
  );
}

function Drawer({ t, r, onClose }) {
  return (
    <div style={{ position: 'fixed', top: 56, right: 0, bottom: 0, width: 380, background: t.panel,
      borderLeft: `1px solid ${t.border}`, boxShadow: t.shadow.lg, padding: 20, overflow: 'auto', zIndex: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div style={{ fontSize: 18, fontWeight: 500 }}>{r.integration_name}</div>
        <button onClick={onClose} style={{ border: `1px solid ${t.border}`, background: t.panel2,
          borderRadius: t.radius.sm, width: 29, height: 29, cursor: 'pointer' }}>{'\u2715'}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <ProjectBadge projectId={r.source_project_id} t={t} />
        <span style={{ color: t.accent }}>{'\u25B6'}</span>
        <ProjectBadge projectId={r.target_project_id} t={t} />
      </div>
      {r.carries_pii === 'Y' && <PiiBadge category={r.pii_categories} t={t} />}
      {[['Source', r.source_system], ['Target', r.target_system], ['Feed Type', r.feed_type],
        ['Direction', r.direction], ['Frequency', r.frequency],
        ['Migration', r.migration_flag === 'Y' ? 'Replacing' : 'Stable'],
        ['Owner', r.update_owner]].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0',
          borderBottom: `1px solid ${t.panel2}`, fontSize: 13 }}>
          <span style={{ color: t.sub }}>{k}</span><b>{v || '\u2014'}</b></div>
      ))}
    </div>
  );
}

const thStyle = (t) => ({ background: '#f0f4f5', textAlign: 'left', padding: '10px 14px',
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
  color: t.accent, borderBottom: `1px solid ${t.disabled}` });
const tdStyle = (t) => ({ padding: '10px 14px', fontSize: 13, borderBottom: '1px solid #eef1f2' });
const chipStyle = (t) => ({ fontSize: 11, fontWeight: 600, padding: '2px 8px',
  borderRadius: t.radius.sm, background: t.infoBg, color: t.info });
const migStyle = (t) => ({ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  padding: '3px 6px', borderRadius: t.radius.sm, background: t.warningBg, color: t.warning });
