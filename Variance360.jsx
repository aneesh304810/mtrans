import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

/* Theme is injected as a prop (AppShell convention). Module-level holder so
   presentational subcomponents can reference it without prop-threading; the
   main component assigns it before any child renders. */
let T = {};

/* ============ shared bits ============ */
const mono = { fontFamily: T.mono };
const Chip = ({ tone, children }) => {
  const map = {
    red: [T.dangerBg, T.danger], amber: [T.warningBg, T.warning],
    green: [T.successBg, T.success], grey: [T.panel2, T.sub],
    blue: [T.infoBg, T.info],
  };
  const [bg, fg] = map[tone] || map.grey;
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px',
    borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' }}>
    {children}</span>;
};
const fmtTone = (inf) => !inf ? 'txt'
  : inf.startsWith('DATE') ? 'date'
  : inf === 'DECIMAL' || inf === 'INTEGER' ? 'num'
  : inf === 'BOOLEAN_FLAG' ? 'flag'
  : inf === 'STRING_NUMERICLOOK' ? 'id'
  : inf.startsWith('MIXED') || inf === 'REVIEW_MIXED' ? 'mix' : 'txt';
const FMT_STYLE = {
  date: { background: '#efe9f8', color: '#7c3aed' },
  num: { background: T.infoBg, color: T.accent },
  flag: { background: T.successBg, color: T.success },
  id: { background: T.dangerBg, color: T.danger },
  mix: { background: T.warningBg, color: T.warning },
  txt: { background: '#f0f2f4', color: T.sub },
};
const FmtChip = ({ inferred, detail }) => (
  <span style={{ ...mono, fontSize: 10, fontWeight: 700, padding: '3px 7px',
    borderRadius: 3, display: 'inline-block',
    ...FMT_STYLE[fmtTone(inferred)] }}>
    {(inferred || '—').replace('STRING_NUMERICLOOK', 'IDENTIFIER')
      .replace(/^DATE:.*/, 'DATE')}
    <span style={{ display: 'block', fontWeight: 400, fontSize: 8.5,
      opacity: 0.85 }}>{detail || '\u00A0'}</span>
  </span>);

const CompBar = ({ c }) => {
  const segs = [
    ['pct_decimal', T.accent], ['pct_integer', '#5f87a7'],
    ['pct_date', '#7c3aed'], ['pct_bool', T.success],
    ['pct_bad', T.danger], ['pct_blank', '#e8ecef'],
  ];
  return (
    <div style={{ height: 14, borderRadius: 2, overflow: 'hidden',
      display: 'flex', border: `1px solid ${T.panel2}` }}>
      {segs.map(([k, col]) => {
        const w = Number(c[k] || 0);
        return w > 0 ? <i key={k} style={{ display: 'block', height: '100%',
          width: `${Math.max(w, k === 'pct_bad' ? 1 : 0)}%`,
          background: col }} /> : null;
      })}
    </div>);
};

const num = (v, d = 0) => v == null ? '—'
  : Number(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
  : Number(v) >= 1e3 ? `${(v / 1e3).toFixed(d ? 1 : 0)}K`
  : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

/* ============ tab 0: tables ============ */
const Hop = ({ label, kind }) => {
  const styles = {
    ok: { border: '1.5px solid #9fb6a9', background: T.successBg, color: '#41604f' },
    brk: { border: `1.5px solid ${T.danger}`, background: T.dangerBg,
      color: T.danger, fontWeight: 700 },
    file: { border: `1.5px dashed ${T.border}`, background: '#f4f6f8', color: T.sub },
    multi: { border: `1.5px solid ${T.info}`, background: T.infoBg, color: T.info },
    clob: { border: '1.5px solid #7c3aed', background: '#efe9f8', color: '#7c3aed' },
  };
  return <span style={{ ...mono, fontSize: 8.5, padding: '2px 6px',
    borderRadius: 999, whiteSpace: 'nowrap', ...(styles[kind] || styles.ok) }}>
    {label}</span>;
};

function TablesTab({ sum, onPick, onClob }) {
  const rows = sum?.tables || [];
  if (!rows.length) return <Empty msg="No stage-variance results yet — run a profile." />;
  return (
    <Panel title={`Tables by variance score · ${sum.run_id || ''}`}
      hint="⛁ file · ×2 multi-feed (combined) · CLOB packed · GRAIN Δ expected">
      {rows.map((r, i) => {
        const status = (r.status || 'GREEN').toUpperCase();
        const isClob = /FEE_BLOCKS|_CLOB/.test(r.table_name || '');
        return (
          <div key={r.table_name}
            onClick={() => (isClob ? onClob(r.table_name) : onPick(r.table_name))}
            style={{ display: 'grid', gridTemplateColumns:
              '22px 210px 1fr 210px 130px 62px', gap: 11, alignItems: 'center',
              padding: '10px 14px', borderBottom: `1px solid ${T.panel2}`,
              cursor: 'pointer' }}>
            <span style={{ ...mono, fontSize: 11, color: T.sub }}>{i + 1}</span>
            <div>
              <div style={{ ...mono, fontSize: 11.5, fontWeight: 700,
                color: T.navy }}>{r.table_name}</div>
              <div style={{ fontSize: 9.5, color: T.sub }}>
                {r.functional_group || ''} · {r.fields_total} fields</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 13, background: '#eef1f4',
                borderRadius: 2, overflow: 'hidden' }}>
                <i style={{ display: 'block', height: '100%',
                  width: `${Math.min(Number(r.variance_score || 0) * 1.2, 100)}%`,
                  background: status === 'RED' ? T.danger
                    : status === 'AMBER' ? T.warning : T.info }} />
              </div>
              <span style={{ ...mono, fontSize: 11, fontWeight: 700,
                width: 84, textAlign: 'right' }}>
                {r.variance_score ?? '—'}
                <span style={{ display: 'block', fontWeight: 400, fontSize: 9,
                  color: T.sub }}>{r.fields_variant}/{r.fields_total} variant</span>
              </span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Hop label="SRC ⛁" kind="file" />
              <Hop label={isClob ? 'STG1 CLOB' : 'STG1'}
                kind={isClob ? 'clob'
                  : (r.breaks_src_stg1 > 0 ? 'brk' : 'ok')} />
              <Hop label="STG2" kind={r.breaks_stg1_stg2 > 0 ? 'brk' : 'ok'} />
              <Hop label="DWH" kind={r.breaks_stg2_dwh > 0 ? 'brk' : 'ok'} />
            </div>
            <span style={{ ...mono, fontSize: 10, color: T.sub }}>
              {r.dominant_metric
                ? <b style={{ color: T.danger }}>{r.dominant_metric}</b>
                : 'no breaks'} {r.worst_hop ? `· ${r.worst_hop}` : ''}</span>
            <Chip tone={status === 'RED' ? 'red' : status === 'AMBER'
              ? 'amber' : status === 'GRAIN' ? 'grey' : 'green'}>
              {status === 'GRAIN' ? 'GRAIN Δ' : status}</Chip>
          </div>);
      })}
    </Panel>);
}

/* ============ tab 1: composition ============ */
function FailCensus({ ft }) {
  const entries = Object.entries(ft || {});
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: 3, ...mono, fontSize: 8.5, lineHeight: 1.7 }}>
      {entries.map(([k, v]) => (
        <span key={k} style={{ marginRight: 6, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 700, padding: '0 4px', borderRadius: 2,
            ...(k.startsWith('DATE') ? FMT_STYLE.date
              : k === 'NUMERIC' ? FMT_STYLE.num
              : k === 'FLAG_VALUE' ? FMT_STYLE.flag : FMT_STYLE.txt) }}>
            {k.replace('DATE:', '')}</span> {v}
        </span>))}
    </div>);
}

function CompositionTab({ ds, table, tables, onTable }) {
  const [stage, setStage] = useState('DWH');
  const [comp, setComp] = useState(null);
  useEffect(() => {
    if (!table) return;
    let ok = true;
    api.varComposition(table, ds, stage).then((d) => ok && setComp(d));
    return () => { ok = false; };
  }, [ds, table, stage]);
  const cols = comp?.columns || [];
  return (
    <Panel title={table ? `${table} · content, format & deviation` : 'Column composition'}
      hint={(
        <span>
          table&nbsp;
          <select value={table || ''} onChange={(e) => onTable(e.target.value)}
            style={{ height: 24, fontSize: 11 }}>
            <option value="">select…</option>
            {tables.map((x) => <option key={x}>{x}</option>)}
          </select>
          &nbsp;stage&nbsp;
          <select value={stage} onChange={(e) => setStage(e.target.value)}
            style={{ height: 24, fontSize: 11 }}>
            {['SRC', 'STG1', 'STG2', 'DWH'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </span>)}>
      {!table ? <Empty msg="Select a table." />
        : !cols.length ? <Empty msg={`No composition rows at ${stage} — run a profile or switch stage.`} />
        : (
          <>
            <GridHead cols={['Column', 'Declared', 'Detected format',
              'Composition', 'Deviation', 'Verdict + failing census']}
              widths="170px 80px 114px 1fr 104px 235px" />
            {cols.map((c) => {
              const inf = c.inferred_type || '';
              const risk = c.risk;
              const tone = risk ? (risk === 'REVIEW_MIXED' ? T.warning : T.danger)
                : T.success;
              const fmtDetail = inf.startsWith('DATE:') ? inf.slice(5)
                : inf === 'DECIMAL'
                  ? `NUMBER(${c.num_prec_max || '?'},${c.num_scale_max ?? '?'})`
                  : inf === 'STRING_NUMERICLOOK'
                    ? `${num(c.lead_zero_rows)} lead-0`
                    : c.max_len ? `maxlen ${c.max_len}` : '';
              return (
                <div key={c.column_name} style={{ display: 'grid',
                  gridTemplateColumns: '170px 80px 114px 1fr 104px 235px',
                  gap: 10, alignItems: 'center', padding: '8px 14px',
                  borderBottom: `1px solid ${T.panel2}` }}>
                  <div>
                    <div style={{ ...mono, fontSize: 11, fontWeight: 700,
                      color: T.navy, overflowWrap: 'anywhere' }}>
                      {c.column_name}</div>
                  </div>
                  <span style={{ ...mono, fontSize: 9.5, color: T.sub }}>
                    {c.declared_type}</span>
                  <FmtChip inferred={inf} detail={fmtDetail} />
                  <div>
                    <CompBar c={c} />
                    <div style={{ display: 'flex',
                      justifyContent: 'space-between', ...mono, fontSize: 8.5,
                      color: T.sub, marginTop: 2 }}>
                      <span>{c.conformance_pct}% conform</span>
                      {Number(c.bad_rows) > 0
                        && <span style={{ color: T.danger }}>
                          {num(c.bad_rows)} fail</span>}
                      <span>{c.pct_blank}% blank</span>
                    </div>
                    <div style={{ ...mono, fontSize: 8.5, color: T.sub }}>
                      n = <b style={{ color: T.navy }}>{num(c.nonnull_rows)}</b>
                      {' '}of <b style={{ color: T.navy }}>{num(c.total_rows)}</b>
                      {c.pii_suppressed === 'Y' && ' · PII — samples hidden'}
                    </div>
                  </div>
                  <div style={{ ...mono, fontSize: 9, color: T.sub,
                    lineHeight: 1.5 }}>
                    {c.mean_val != null ? (
                      <>μ <b style={{ color: T.navy }}>{num(c.mean_val, 1)}</b>
                        {' '}σ <b style={{ color: T.navy }}>
                          {num(c.stddev_val, 1)}</b><br />
                        P50 <b style={{ color: T.navy }}>
                          {num(c.median_val, 1)}</b>
                        {Number(c.outlier_cnt) > 0
                          && <span style={{ color: T.danger, fontWeight: 700 }}>
                            {' '}· {num(c.outlier_cnt)} &gt;3σ</span>}
                      </>)
                      : c.min_val != null
                        ? <>range<br /><b style={{ color: T.navy }}>
                            {String(c.min_val).slice(0, 10)}→
                            {String(c.max_val).slice(0, 10)}</b></>
                        : c.value_census
                          ? <>{c.ndv} distinct<br />
                              {String(c.value_census).slice(0, 40)}</>
                          : '—'}
                  </div>
                  <div style={{ fontSize: 10, lineHeight: 1.35 }}>
                    <b style={{ ...mono, fontSize: 9.5, color: tone }}>
                      {risk || 'CLEAN'}</b>
                    {c.verdict && <><br />{String(c.verdict).slice(0, 90)}</>}
                    <FailCensus ft={c.fail_types} />
                  </div>
                </div>);
            })}
          </>)}
    </Panel>);
}

/* ============ tab 2: CLOB inspector ============ */
function segColor(inferred) {
  if (!inferred) return '#9fb0bd';
  if (inferred.startsWith('DATE')) return '#7c3aed';
  if (inferred === 'DECIMAL') return T.accent;
  if (inferred === 'INTEGER') return '#5f87a7';
  if (inferred === 'BOOLEAN_FLAG') return T.success;
  return '#9fb0bd';
}
const MCard = ({ n, l }) => (
  <div style={{ padding: '8px 13px', borderRight: `1px solid ${T.panel2}` }}>
    <div style={{ ...mono, fontSize: 15, fontWeight: 700, color: T.navy }}>
      {n}</div>
    <div style={{ fontSize: 9, textTransform: 'uppercase',
      letterSpacing: '.04em', color: T.sub }}>{l}</div>
  </div>);

function ClobTab({ ds, table, tables, onTable }) {
  const [cols, setCols] = useState(null);
  const [sel, setSel] = useState(null);
  const [fields, setFields] = useState(null);
  const [rec, setRec] = useState(null);
  const [inspected, setInspected] = useState([]);
  useEffect(() => {
    api.varClobTables(ds).then((d) => setInspected(d.tables || []));
  }, [ds]);
  const allTables = useMemo(
    () => Array.from(new Set([...inspected, ...tables])).sort(),
    [inspected, tables]);
  useEffect(() => {
    if (!table) return;
    setSel(null); setFields(null); setRec(null);
    api.varClobColumns(table, ds).then((d) => {
      setCols(d.columns || []);
      if ((d.columns || []).length === 1) setSel(d.columns[0].column_name);
    });
  }, [ds, table]);
  useEffect(() => {
    if (!table || !sel) return;
    api.varClobProfile(table, sel, ds).then((d) => setFields(d.fields || []));
    api.varClobRecord(table, sel, ds).then(setRec);
  }, [ds, table, sel]);

  const selRow = (cols || []).find((c) => c.column_name === sel);
  const fixed = selRow && (selRow.structure || '').startsWith('FIXED');
  const specd = (fields || []).filter((f) => f.pos_start != null);
  const unmapped = (fields || []).filter((f) => f.risk === 'UNMAPPED_DATA');
  const recEnd = specd.length
    ? Math.max(...specd.map((f) => f.pos_start + f.pos_len - 1)) : 0;
  const raw = rec && !rec.suppressed ? rec.record : null;

  return (
    <>
      {/* ---- CLOB column cards ---- */}
      <Panel title={`CLOB columns · ${table || 'select a table'}`}
        hint={(
          <span>from ALL_TAB_COLUMNS · click a CLOB to inspect&nbsp;
            <select value={table || ''}
              onChange={(e) => onTable(e.target.value)}
              style={{ height: 24, fontSize: 11 }}>
              <option value="">select table…</option>
              {allTables.map((x) => <option key={x}>{x}</option>)}
            </select>
          </span>)}>
        {!cols
          ? <Empty msg="Select a table with CLOB columns." />
          : !cols.length
            ? <Empty msg="No CLOB inspection results — run: python -m ingestion.clob_inspector --table <T>" />
            : cols.map((c) => {
              const isSel = sel === c.column_name;
              return (
                <div key={c.column_name} onClick={() => setSel(c.column_name)}
                  style={{ display: 'grid', gridTemplateColumns:
                    '200px 1fr 150px 150px 120px 70px', gap: 11,
                    alignItems: 'center', padding: '10px 14px',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${T.panel2}`,
                    background: isSel ? T.infoBg : undefined }}>
                  <div>
                    <div style={{ ...mono, fontSize: 11.5, fontWeight: 700,
                      color: T.navy }}>{c.column_name}</div>
                    <div style={{ fontSize: 9.5, color: T.sub }}>
                      {c.structure}{isSel ? ' · SELECTED' : ''}</div>
                  </div>
                  <span style={{ ...mono, fontSize: 10, color: T.sub }}>
                    {num(c.blob_count)} blobs · len {c.len_mode}
                    {' '}({c.len_uniform_pct}% uniform)</span>
                  <span style={{ ...mono, fontSize: 10, color: T.sub }}>
                    {c.spec_fields
                      ? `${c.spec_resolved}/${c.spec_fields} fields parseable`
                      : 'no parse spec in lineage'}</span>
                  <span style={{ ...mono, fontSize: 10 }}>
                    {c.unmapped_regions
                      ? <b style={{ color: T.danger }}>
                          unmapped: {c.unmapped_regions}</b>
                      : Number(c.truncated_cnt) > 0
                        ? <span style={{ color: T.danger }}>
                            {c.truncated_cnt} truncated</span>
                        : <span style={{ color: T.sub }}>fully mapped</span>}
                  </span>
                  <span style={{ ...mono, fontSize: 10, color: T.sub }}>
                    {c.referenced_by_transform === 'Y'
                      ? 'referenced by ETL' : 'not referenced'}</span>
                  <Chip tone={isSel ? 'amber' : 'grey'}>
                    {isSel ? 'INSPECT ▾'
                      : (c.structure || '').startsWith('FIXED') ? 'VIEW'
                        : 'TEXT'}</Chip>
                </div>);
            })}
      </Panel>

      {/* ---- banner ---- */}
      {sel && fixed && specd.length > 0 && (
        <div style={{ background: T.infoBg, border: '1px solid #b9d0e8',
          borderRadius: 3, padding: '7px 13px', fontSize: 11.5,
          color: T.accent, marginBottom: 12 }}>
          <b style={{ ...mono, fontSize: 10.5 }}>STG1 unlocked:</b> parse spec
          lifted from <b style={{ ...mono, fontSize: 10.5 }}>
          stg1_to_stg2_transform</b> · {specd.length} fields profiled inside
          the CLOB{unmapped.length
            ? <> · {unmapped.length} unmapped region{unmapped.length > 1
              ? 's' : ''} found</> : ''} · grain change annotated</div>)}

      {/* ---- detail: metadata strip + record layout ---- */}
      {sel && selRow && (
        <Panel title={`▾ ${sel} · record structure & parse spec · ${
            num(selRow.blob_count)} blobs`}
          hint={`${selRow.structure} · ${selRow.spec_resolved || 0}/${
            selRow.spec_fields || 0} fields SUBSTR-resolvable`}>
          <div style={{ display: 'grid',
            gridTemplateColumns: 'repeat(6,1fr)',
            borderBottom: `1px solid ${T.panel2}` }}>
            <MCard n={num(selRow.blob_count)} l="Blobs" />
            <MCard n={selRow.len_mode ?? '—'}
              l={`Len · ${selRow.len_uniform_pct ?? '—'}% uniform`} />
            <MCard n={selRow.truncated_cnt ?? 0}
              l={`Truncated (≠${selRow.len_mode ?? '—'})`} />
            <MCard n={(selRow.structure || '').slice(0, 8)} l="Format" />
            <MCard n={selRow.spec_fields ?? 0} l="Fields in spec" />
            <MCard n={`${selRow.spec_resolved ?? 0}/${
              selRow.spec_fields ?? 0}`} l="Spec coverage" />
          </div>
          {fixed && specd.length > 0 && (
            <div style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', height: 40, borderRadius: 3,
                overflow: 'hidden', border: `1px solid ${T.panel2}`,
                marginBottom: 6 }}>
                {specd.map((f) => (
                  <div key={f.field_name}
                    title={`${f.field_name} · ${f.pos_start}–${
                      f.pos_start + f.pos_len - 1} · ${f.inferred_type}`}
                    style={{ width: `${(100 * f.pos_len) / recEnd}%`,
                      minWidth: 14, display: 'flex',
                      flexDirection: 'column', justifyContent: 'center',
                      padding: '0 3px', borderRight: '1px solid #fff',
                      background: f.risk === 'UNMAPPED_DATA'
                        ? `repeating-linear-gradient(45deg, ${T.danger}, ${
                            T.danger} 5px, #a50d31 5px, #a50d31 10px)`
                        : segColor(f.inferred_type),
                      color: '#fff', ...mono, fontSize: 8,
                      overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    <b style={{ fontSize: 8.5 }}>
                      {f.risk === 'UNMAPPED_DATA' ? '??' : f.field_name}</b>
                    <span style={{ opacity: 0.85, fontSize: 7.5 }}>
                      {f.pos_start}–{f.pos_start + f.pos_len - 1}</span>
                  </div>))}
              </div>
              {raw && (
                <div style={{ ...mono, fontSize: 10.5,
                  background: '#0f1c33', color: '#9fd0a8', borderRadius: 3,
                  padding: '8px 10px', overflowX: 'auto',
                  whiteSpace: 'pre' }}>
                  {specd.map((f) => (
                    <span key={f.field_name}
                      title={`${f.field_name} (${f.inferred_type})`}
                      style={{ color: f.risk === 'UNMAPPED_DATA' ? '#ff7d7d'
                        : f.inferred_type?.startsWith('DATE') ? '#c9a7f5'
                        : ['DECIMAL', 'INTEGER'].includes(f.inferred_type)
                          ? '#7fb5e8'
                        : f.inferred_type === 'BOOLEAN_FLAG' ? '#7fe0c0'
                          : '#9fd0a8',
                        textDecoration: f.risk === 'UNMAPPED_DATA'
                          ? 'underline wavy' : 'none' }}>
                      {raw.slice(f.pos_start - 1,
                                 f.pos_start - 1 + f.pos_len)}
                    </span>))}
                </div>)}
              <div style={{ fontSize: 10.5, color: T.sub, marginTop: 7 }}>
                {rec?.suppressed
                  ? 'raw record suppressed — PII fields present'
                  : 'one sample record · colors = detected content class'}
                {unmapped.map((u) => (
                  <b key={u.field_name} style={{ color: T.danger }}>
                    {' '}· bytes {u.pos_start}–{u.pos_start + u.pos_len - 1}
                    {' '}unmapped, non-blank in {num(u.nonnull_rows)} blobs
                    {' '}— ask the source owner</b>))}
              </div>
            </div>)}
        </Panel>)}

      {/* ---- parsed fields / census grid ---- */}
      {sel && (
        <Panel title={fixed
            ? 'Parsed fields · composition & deviation inside the CLOB'
            : `▾ ${sel} · content census`}
          hint={fixed
            ? 'parse spec from stg1_to_stg2_transform · census via DBMS_LOB'
            : 'per-structure census · values masked per registry sensitivity'}>
          {!fields ? <Empty msg="loading…" />
            : !fields.length
              ? <Empty msg="No census yet — rerun the CLOB inspector." />
              : (
                <>
                  <GridHead cols={['Field', 'Position', 'Format',
                    'Conformance', 'Deviation', 'Verdict']}
                    widths="170px 86px 110px 1fr 110px 250px" />
                  {fields.map((f) => (
                    <div key={f.field_name} style={{ display: 'grid',
                      gridTemplateColumns:
                        '170px 86px 110px 1fr 110px 250px',
                      gap: 10, alignItems: 'center', padding: '8px 14px',
                      borderBottom: `1px solid ${T.panel2}` }}>
                      <div>
                        <div style={{ ...mono, fontSize: 11,
                          fontWeight: 700, color: T.navy }}>
                          {f.field_name}</div>
                        {f.target_column && <div style={{ fontSize: 9,
                          color: T.sub }}>→ STG2.{f.target_column}</div>}
                      </div>
                      <span style={{ ...mono, fontSize: 9.5,
                        color: T.sub }}>
                        {f.pos_start != null
                          ? `${f.pos_start}–${
                              f.pos_start + f.pos_len - 1}`
                          : f.inferred_type === 'JSON_KEY' ? 'key'
                          : f.inferred_type === 'LIST_TOKEN' ? 'token'
                            : '·'}</span>
                      <FmtChip inferred={f.inferred_type}
                        detail={f.date_mask || ''} />
                      <div style={{ ...mono, fontSize: 9.5,
                        color: T.sub }}>
                        {f.conformance_pct != null
                          ? `${f.conformance_pct}% · ` : ''}
                        n = <b style={{ color: T.navy }}>
                          {num(f.nonnull_rows)}</b>
                        {' '}of {num(f.total_rows)}
                        {Number(f.bad_rows) > 0 && <span style={{
                          color: T.danger }}>
                          {' '}· {num(f.bad_rows)} fail</span>}
                      </div>
                      <span style={{ ...mono, fontSize: 9,
                        color: T.sub }}>
                        {f.mean_val != null
                          ? <>μ <b style={{ color: T.navy }}>
                              {num(f.mean_val, 1)}</b>
                              {f.stddev_val != null
                                ? <> σ {num(f.stddev_val, 1)}</> : null}</>
                          : '—'}</span>
                      <div style={{ fontSize: 10 }}>
                        {['TEXT_VALUE', 'JSON_KEY', 'LIST_TOKEN']
                          .includes(f.inferred_type)
                          ? <span style={{ ...mono, fontSize: 9.5 }}>
                              “{f.verdict}”</span>
                          : <>
                              <b style={{ ...mono, fontSize: 9.5,
                                color: ['UNMAPPED_DATA',
                                  'CLOB_OVERSIZED_TYPE', 'REGISTRY_DRIFT',
                                  'PARSER_ERROR']
                                  .includes(f.risk) ? T.warning
                                  : f.risk ? T.danger : T.success }}>
                                {f.risk || 'CLEAN'}</b>
                              {f.verdict && <><br />{f.verdict}</>}
                            </>}
                      </div>
                    </div>))}
                </>)}
        </Panel>)}
    </>);
}

/* ============ tab 3: coverage ============ */
const COV_META = {
  Exists: ['Verified chains', T.success, 'PROFILED', 'green'],
  mapped: ['Verified chains', T.success, 'PROFILED', 'green'],
  '(blank)': ['Unstatused lineage', T.warning, 'TRIAGE', 'amber'],
  'Not Applicable': ['DWH-generated', '#9fb0bd', 'JUSTIFIED', 'grey'],
  'Does Not Exist': ['Stale mappings', T.danger, 'FIX LINEAGE', 'red'],
  unmapped: ['Known gaps', T.danger, 'MAP', 'red'],
};
function CoverageTab({ ds }) {
  const [cov, setCov] = useState(null);
  useEffect(() => { api.varCoverage(ds).then(setCov); }, [ds]);
  if (!cov) return <Empty msg="loading…" />;
  const total = cov.census.reduce((a, r) => a + Number(r.cnt), 0) || 1;
  const verified = cov.census
    .filter((r) => ['Exists', 'mapped'].includes(r.status))
    .reduce((a, r) => a + Number(r.cnt), 0);
  const census = [
    ...(verified ? [{ status: 'Exists + mapped', cnt: verified,
      _meta: ['Verified chains', T.success, 'PROFILED', 'green'] }] : []),
    ...cov.census.filter((r) => !['Exists', 'mapped'].includes(r.status)),
  ];
  return (
    <>
      <Panel title={`Lineage & profiling coverage · ${ds}`}
        hint="legacy_lineage status census">
        {census.map((r) => {
          const [label, color, action, tone] = r._meta || COV_META[r.status]
            || [r.status, T.sub, 'REVIEW', 'grey'];
          return (
            <div key={r.status} style={{ display: 'grid',
              gridTemplateColumns: '225px 1fr 120px 118px', gap: 11,
              padding: '8px 14px', alignItems: 'center', fontSize: 12,
              borderBottom: `1px solid ${T.panel2}` }}>
              <span><b>{label}</b> <span style={{ color: T.sub,
                fontSize: 10.5 }}>({r.status})</span></span>
              <div style={{ height: 11, background: '#eef1f4',
                borderRadius: 2, overflow: 'hidden' }}>
                <i style={{ display: 'block', height: '100%',
                  width: `${(100 * r.cnt) / total}%`, background: color }} />
              </div>
              <span style={{ ...mono, fontSize: 10.5, color: T.sub }}>
                {num(r.cnt)} fields</span>
              <Chip tone={tone}>{action}</Chip>
            </div>);
        })}
      </Panel>
      <Panel title={`Tables with no lineage · ${cov.gaps.length}`}
        hint="confirm with owners — derived tables may be justified">
        <div style={{ padding: '9px 14px', ...mono, fontSize: 11,
          lineHeight: 1.9, color: T.navy }}>
          {cov.gaps.join(' · ') || 'none 🎉'}</div>
      </Panel>
    </>);
}

/* ============ tab 4: runs ============ */
function RunsTab({ runs }) {
  if (!runs?.length) return <Empty msg="No runs yet." />;
  return (
    <Panel title="Runs & evidence trail" hint="immutable · RECON_* · NYDFS">
      {runs.map((r) => (
        <div key={r.run_id} style={{ display: 'grid', gridTemplateColumns:
          '180px 78px 92px 1fr', gap: 11, padding: '9px 14px',
          alignItems: 'center', fontSize: 11.5,
          borderBottom: `1px solid ${T.panel2}` }}>
          <span style={{ ...mono, fontSize: 10.5, fontWeight: 700 }}>
            {r.run_id}</span>
          <span>{r.run_type}</span>
          <span style={{ fontWeight: 700, color: r.status === 'COMPLETE'
            ? T.success : r.status === 'FAILED' ? T.danger : T.warning }}>
            {r.status}</span>
          <span style={{ ...mono, fontSize: 10.5, color: T.sub }}>
            {r.scope || 'full'} · {r.rows_scanned
              ? `${num(r.rows_scanned)} rows` : ''} {r.cols_profiled
              ? `· ${num(r.cols_profiled)} cols` : ''} {r.error_text
              ? `· ${String(r.error_text).slice(0, 80)}` : ''}</span>
        </div>))}
    </Panel>);
}

/* ============ scaffolding ============ */
const Panel = ({ title, hint, children }) => (
  <div style={{ background: T.panel, border: `1px solid ${T.border}`,
    borderRadius: 3, boxShadow: '0 3px 5px rgba(0,0,0,.08)',
    overflow: 'hidden', marginBottom: 13 }}>
    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 14px',
      borderBottom: `1px solid ${T.panel2}`, background: '#fafcfc' }}>
      <h2 style={{ fontSize: 11.5, fontWeight: 700,
        textTransform: 'uppercase', margin: 0 }}>{title}</h2>
      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.sub }}>
        {hint}</span>
    </div>
    {children}
  </div>);
const GridHead = ({ cols, widths }) => (
  <div style={{ display: 'grid', gridTemplateColumns: widths, gap: 10,
    padding: '6px 14px', fontSize: 9.5, textTransform: 'uppercase',
    letterSpacing: '.05em', color: T.sub, fontWeight: 700,
    background: '#fafcfc', borderBottom: `1px solid ${T.panel2}` }}>
    {cols.map((c) => <span key={c}>{c}</span>)}
  </div>);
const Empty = ({ msg }) => (
  <div style={{ padding: '26px 14px', textAlign: 'center', color: T.sub,
    fontSize: 12.5 }}>{msg}</div>);

/* ============ main ============ */
export default function Variance360({ t }) {
  T = {
    infoBg: '#e0f5fd', mono: "'Roboto Mono', monospace",
    panel2: '#dfe6e9', navy: '#10193b', info: '#0091bf', ...t,
  };
  const [ds, setDs] = useState('PBDW');
  const [sources, setSources] = useState([]);
  const [sum, setSum] = useState(null);
  const [runs, setRuns] = useState([]);
  const [tab, setTab] = useState(0);
  const [table, setTable] = useState('');
  const [genState, setGenState] = useState(null);

  const refresh = () => {
    api.varSummary(ds).then(setSum);
    api.varRuns(ds).then((d) => setRuns(d.runs || []));
  };
  useEffect(() => { api.varSources().then((d) => setSources(d.sources || [])); }, []);
  useEffect(refresh, [ds]);

  const tables = useMemo(
    () => (sum?.tables || []).map((x) => x.table_name), [sum]);
  const lastRun = runs[0];

  const generate = () => {
    setGenState('starting…');
    api.varGenerate({ data_source: ds, table: table || null })
      .then((d) => setGenState(`run ${d.run_id} started — refresh in a few min`))
      .catch(() => setGenState('failed to start'));
  };

  const src = sources.find((s) => s.data_source === ds);
  return (
    <div>
      <h1 style={{ fontSize: 19, fontWeight: 500, margin: '0 0 2px' }}>
        Variance 360</h1>
      <div style={{ color: T.sub, fontSize: 12.5, marginBottom: 12 }}>
        Column composition, format inference, deviation & stage variance ·
        {' '}<code style={{ ...mono, fontSize: 11, background: T.panel2,
          padding: '1px 5px', borderRadius: 2 }}>SRC → STG1 → STG2 → DWH</code>
        {' '}· NYDFS evidence-tagged
      </div>

      <div style={{ background: T.panel, border: `1px solid ${T.border}`,
        borderRadius: 3, boxShadow: '0 3px 5px rgba(0,0,0,.08)',
        padding: '10px 14px', display: 'flex', gap: 10, flexWrap: 'wrap',
        alignItems: 'flex-end', marginBottom: 12 }}>
        <Field label="Data source">
          <select value={ds} onChange={(e) => setDs(e.target.value)}
            style={{ height: 30, minWidth: 210 }}>
            {(sources.length ? sources : [{ data_source: 'PBDW' }]).map((s) => (
              <option key={s.data_source} value={s.data_source}>
                {s.data_source}
                {s.mapped_fields
                  ? ` — ${s.mapped_fields}/${s.total_fields} mapped` : ''}
              </option>))}
          </select>
        </Field>
        <Field label="Table (optional)">
          <select value={table} onChange={(e) => setTable(e.target.value)}
            style={{ height: 30, minWidth: 190 }}>
            <option value="">All mapped tables</option>
            {tables.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <button type="button" onClick={generate}
          style={{ height: 30, background: T.accent, color: '#fff', border: 0,
            borderRadius: 2, fontSize: 12, fontWeight: 500, padding: '0 14px',
            cursor: 'pointer' }}>▶&nbsp;Generate</button>
        {genState && <span style={{ fontSize: 11, color: T.sub,
          alignSelf: 'center' }}>{genState}</span>}
        <div style={{ marginLeft: 'auto', alignSelf: 'center', ...mono,
          fontSize: 10, color: T.sub, textAlign: 'right', lineHeight: 1.5 }}>
          {lastRun ? (
            <>last run <b style={{ color: lastRun.status === 'COMPLETE'
              ? T.success : T.danger }}>{lastRun.status?.toLowerCase()}</b>
              {' '}{lastRun.run_id}<br />
              {lastRun.rows_scanned ? `${num(lastRun.rows_scanned)} rows · ` : ''}
              {lastRun.cols_profiled ? `${num(lastRun.cols_profiled)} cols` : ''}
            </>) : 'no runs yet'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 12,
        borderBottom: `2px solid ${T.panel2}` }}>
        {['High Variance Tables', 'Column Composition', 'CLOB Inspector',
          'Coverage', 'Runs & Evidence'].map((label, i) => (
          <span key={label} onClick={() => setTab(i)}
            style={{ padding: '7px 13px', fontSize: 12.5, cursor: 'pointer',
              marginBottom: -2,
              color: tab === i ? T.text : T.sub,
              fontWeight: tab === i ? 500 : 400,
              borderBottom: `2px solid ${tab === i ? T.accent : 'transparent'}` }}>
            {label}</span>))}
      </div>

      {tab === 0 && <TablesTab sum={sum}
        onPick={(x) => { setTable(x); setTab(1); }}
        onClob={(x) => { setTable(x); setTab(2); }} />}
      {tab === 1 && <CompositionTab ds={ds} table={table} tables={tables}
        onTable={setTable} />}
      {tab === 2 && <ClobTab ds={ds} table={table} tables={tables}
        onTable={setTable} />}
      {tab === 3 && <CoverageTab ds={ds} />}
      {tab === 4 && <RunsTab runs={runs} />}
    </div>);
}

const Field = ({ label, children }) => (
  <div>
    <label style={{ display: 'block', fontSize: 9.5,
      textTransform: 'uppercase', letterSpacing: '.06em', color: T.sub,
      fontWeight: 700, marginBottom: 2 }}>{label}</label>
    {children}
  </div>);
