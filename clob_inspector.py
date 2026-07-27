"""
clob_inspector.py — Variance 360 CLOB Inspector.

For a table's CLOB columns:
  1. discover      — list CLOB columns (ALL_TAB_COLUMNS)
  2. blob metadata — count, length min/max/avg/mode, uniformity, truncated
  3. parse spec    — lift SUBSTR(clob, pos, len) expressions from
                     legacy_lineage.stg1_to_stg2_transform (the ETL's own
                     parsing logic is the ground truth)
  4. field profile — VALIDATE_CONVERSION census + deviation per parsed field,
                     computed INSIDE the CLOB
  5. gaps          — byte regions covered by no transform, with non-blank
                     counts (unknown data riding in the record)

Results -> recon_clob_profile / recon_clob_fields (SILVER), evidence-tagged.

Usage:
    python -m ingestion.clob_inspector --data-source PBDW \\
        --table STG1_FIS_ACCOUNT_FEE_BLOCKS [--clob BLOCK_CLOB]
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import re
import sys
from collections import Counter

from ingestion.variance_engine import (
    _catalog, _source_conn, _qual, _col_types, _phys, _oracle_mask,
    _DEFAULT_MASKS, load_dictionary,
)

log = logging.getLogger("cp.variance.clob")

_SUBSTR_RE = re.compile(
    r"SUBSTR\s*\(\s*([A-Z0-9_\.\"]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)",
    re.IGNORECASE)


# ---------------------------------------------------------------------------
# structure registry: the curated taxonomy (recon_clob_registry) overrides
# auto-detection and drives parser dispatch + value suppression
# ---------------------------------------------------------------------------
_SUPPRESS_HINTS = ("PII", "ATTRIBUTE_PAYLOAD")


def load_registry(ccur):
    try:
        ccur.execute("""SELECT UPPER(table_name), UPPER(column_name),
                               parser_family, structure_name,
                               NVL(sensitivity_hint, 'NONE'),
                               delimiter_pattern
                        FROM recon_clob_registry""")
        return {(t, c): dict(family=f, name=n, hint=h, delim=d)
                for t, c, f, n, h, d in ccur.fetchall()}
    except Exception:                                       # noqa: BLE001
        log.info("no recon_clob_registry — auto-detection only")
        return {}


def _mask(v):
    """Shape-preserving mask for suppressed values: letters->A, digits->9."""
    out = []
    for ch in (v or ""):
        out.append("A" if ch.isalpha() else "9" if ch.isdigit() else ch)
    return "".join(out)


def _mk(field, inferred, nn, total, verdict, risk=None, mean=None):
    return dict(field_name=field, pos_start=None, pos_len=None,
                target_column=None, inferred_type=inferred,
                conformance_pct=None, nonnull_rows=nn, total_rows=total,
                bad_rows=0, mean_val=mean, stddev_val=None, date_mask=None,
                risk=risk, verdict=(verdict or "")[:380])


def profile_json(scur, qtab, clob_col, suppress, sample_rows=2000):
    """JSON payload census: key coverage across blobs + per-key sample
    (masked when the registry marks the payload sensitive)."""
    import json as _json
    c = f'"{clob_col}"'
    scur.execute(f"SELECT CAST(DBMS_LOB.SUBSTR({c}, 3000, 1) "
                 f"AS VARCHAR2(3000)) FROM {qtab} "
                 f"WHERE {c} IS NOT NULL AND ROWNUM <= {sample_rows}")
    keys, samples, parsed, bad = {}, {}, 0, 0
    n = 0
    for (txt,) in scur:
        n += 1
        try:
            obj = _json.loads(txt)
            parsed += 1
        except Exception:                                   # noqa: BLE001
            bad += 1
            continue
        for k, v in (obj.items() if isinstance(obj, dict) else []):
            keys[k] = keys.get(k, 0) + 1
            if k not in samples and not isinstance(v, (dict, list)):
                samples[k] = str(v)
    rows = [_mk("JSON_PROFILE", "JSON", parsed, n,
                f"{parsed}/{n} sampled blobs parse as JSON · "
                f"{len(keys)} distinct keys"
                + (f" · {bad} malformed" if bad else ""),
                risk=("JSON_MALFORMED" if bad else None))]
    def keynum(k):
        d = "".join(ch for ch in k if ch.isdigit())
        return int(d) if d else 0
    for k in sorted(keys, key=keynum)[:40]:
        v = samples.get(k, "")
        rows.append(_mk(k, "JSON_KEY", keys[k], parsed,
                        f"e.g. {_mask(v) if suppress else v}"[:120]))
    return rows


def profile_delimited(scur, qtab, clob_col, delim, suppress,
                      sample_rows=5000):
    """Delimited list census: tokens per row + top token values."""
    from collections import Counter
    major = (delim or "||").split(",")[0] or "||"
    c = f'"{clob_col}"'
    scur.execute(f"SELECT CAST(DBMS_LOB.SUBSTR({c}, 2000, 1) "
                 f"AS VARCHAR2(2000)) FROM {qtab} "
                 f"WHERE {c} IS NOT NULL AND ROWNUM <= {sample_rows}")
    counts, toks, n = [], Counter(), 0
    for (txt,) in scur:
        n += 1
        parts = [p for p in (txt or "").split(major) if p != ""]
        counts.append(len(parts))
        toks.update(parts)
    avg = round(sum(counts) / n, 1) if n else 0
    rows = [_mk("LIST_PROFILE", "DELIMITED", n, n,
                f"sep '{major}' · avg {avg} tokens/row · max "
                f"{max(counts) if counts else 0} · "
                f"{len(toks)} distinct tokens — child entity: "
                f"explode to rows in target model", mean=avg)]
    for tok, cnt in toks.most_common(10):
        rows.append(_mk(f"TOKEN_{cnt}", "LIST_TOKEN", cnt,
                        sum(counts),
                        (_mask(tok) if suppress else tok)[:120]))
    return rows


def profile_empty_check(scur, qtab, clob_col):
    """Registry says EMPTY — verify, and flag drift if data appeared."""
    c = f'"{clob_col}"'
    scur.execute(f"""SELECT COUNT(*),
        COUNT(CASE WHEN {c} IS NOT NULL
                    AND DBMS_LOB.GETLENGTH({c}) > 0 THEN 1 END)
        FROM {qtab}""")
    total, nn = scur.fetchone()
    if nn:
        return [_mk("EMPTY_CHECK", "EMPTY", nn, total,
                    f"registry says EMPTY but {nn:,} rows carry data — "
                    f"registry stale or new upstream behaviour",
                    risk="REGISTRY_DRIFT")]
    return [_mk("EMPTY_CHECK", "EMPTY", 0, total,
                "verified empty — matches registry")]


# ---------------------------------------------------------------------------
def discover_clobs(scur, qtab):
    ctypes = _col_types(scur, qtab)
    return [c for c, t in ctypes.items() if "LOB" in (t or "").upper()]


def blob_metadata(scur, qtab, clob_col):
    c = f'"{clob_col}"'
    # pass 1: length summary (STATS_MODE is aggregate-only — no OVER())
    scur.execute(f"""
        SELECT COUNT(*), MIN(l), MAX(l), ROUND(AVG(l), 1), STATS_MODE(l)
        FROM (SELECT DBMS_LOB.GETLENGTH({c}) l
              FROM {qtab} WHERE {c} IS NOT NULL)""")
    cnt, lmin, lmax, lavg, lmode = scur.fetchone()
    uni, truncated = None, 0
    if cnt and lmode is not None:
        # pass 2: uniformity at the modal length + shorter (truncated) blobs
        scur.execute(f"""
            SELECT ROUND(100 * SUM(CASE WHEN l = :m THEN 1 ELSE 0 END)
                         / COUNT(*), 2),
                   SUM(CASE WHEN l < :m THEN 1 ELSE 0 END)
            FROM (SELECT DBMS_LOB.GETLENGTH({c}) l
                  FROM {qtab} WHERE {c} IS NOT NULL)""", m=lmode)
        uni, truncated = scur.fetchone()
    structure = ("FIXED_WIDTH" if uni and uni >= 95
                 else "TEXT" if lmax and lmin and lmax > 4 * max(lmin, 1)
                 else "UNKNOWN")
    return dict(blob_count=cnt, len_min=lmin, len_max=lmax, len_avg=lavg,
                len_mode=lmode, len_uniform_pct=uni,
                truncated_cnt=truncated or 0, structure=structure)


# ---------------------------------------------------------------------------
def parse_spec_from_lineage(ccur, data_source, stg1_table, clob_col):
    """[(target_stg2_column, pos, len)] lifted from stg1_to_stg2_transform."""
    ccur.execute("""
        SELECT stg2_source_column, stg1_to_stg2_transform
        FROM legacy_lineage
        WHERE NVL(data_source, 'PBDW') = :ds
          AND UPPER(stg1_source_table) = UPPER(:t)
          AND UPPER(stg1_source_column) = UPPER(:c)
          AND stg1_to_stg2_transform IS NOT NULL""",
        {"ds": data_source, "t": stg1_table, "c": clob_col})
    spec, unresolved = [], []
    for target, transform in ccur.fetchall():
        text = transform.read() if hasattr(transform, "read") else str(transform)
        m = _SUBSTR_RE.search(text or "")
        if m and clob_col.upper() in m.group(1).upper():
            spec.append((target, int(m.group(2)), int(m.group(3))))
        else:
            unresolved.append(target)
    spec.sort(key=lambda x: x[1])
    return spec, unresolved


def find_gaps(spec, record_len):
    """Byte regions covered by no field."""
    covered = [False] * (record_len + 1)
    for _, pos, ln in spec:
        for i in range(pos, min(pos + ln, record_len + 1)):
            covered[i] = True
    gaps, start = [], None
    for i in range(1, record_len + 1):
        if not covered[i] and start is None:
            start = i
        elif covered[i] and start is not None:
            gaps.append((start, i - 1))
            start = None
    if start is not None:
        gaps.append((start, record_len))
    return gaps


# ---------------------------------------------------------------------------
def profile_fields(scur, qtab, clob_col, spec, gaps, masks, sample_rows=0):
    """Census per parsed field (and per gap region) inside the CLOB."""
    src = (f"(SELECT * FROM {qtab} WHERE ROWNUM <= {sample_rows})"
           if sample_rows else qtab)
    results = []
    items, manifest = [], []

    def add(field, pos, ln, target):
        v = f'TRIM(DBMS_LOB.SUBSTR("{clob_col}", {ln}, {pos}))'
        num = f"VALIDATE_CONVERSION({v} AS NUMBER)"
        probes = {
            "TOTAL": "COUNT(*)",
            "NONNULL": f"COUNT({v})",
            "NUM_OK": f"SUM(CASE WHEN {v} IS NOT NULL THEN {num} ELSE 0 END)",
            "MEAN": f"AVG(TO_NUMBER({v} DEFAULT NULL ON CONVERSION ERROR))",
            "STDDEV": f"STDDEV(TO_NUMBER({v} DEFAULT NULL ON CONVERSION ERROR))",
        }
        for i, mk in enumerate(masks[:4]):
            probes[f"DT{i}"] = (f"SUM(CASE WHEN {v} IS NOT NULL THEN "
                                f"VALIDATE_CONVERSION({v} AS DATE, '{mk}') "
                                f"ELSE 0 END)")
        probes["FLAG"] = (f"SUM(CASE WHEN UPPER({v}) IN ('Y','N') "
                          f"THEN 1 ELSE 0 END)")
        for name, expr in probes.items():
            alias = f"P{len(manifest)}"
            items.append(f"{expr} AS {alias}")
            manifest.append((field, pos, ln, target, name))

    for target, pos, ln in spec:
        add(target, pos, ln, target)
    for g0, g1 in gaps:
        if g1 - g0 >= 1:                       # skip 1-byte slivers
            add(f"BYTES_{g0}_{g1}", g0, g1 - g0 + 1, None)

    if not manifest:
        return results
    scur.execute("SELECT " + ", ".join(items) + f" FROM {src}")
    row = scur.fetchone()
    stats = {}
    for (field, pos, ln, target, name), val in zip(manifest, row):
        stats.setdefault(field, {"pos": pos, "len": ln,
                                 "target": target})[name] = val

    for field, st in stats.items():
        nn = st.get("NONNULL") or 0
        total = st.get("TOTAL") or 0
        pct = lambda k: 100.0 * (st.get(k) or 0) / nn if nn else 0.0
        best_date, best_mask = 0.0, None
        for i, mk in enumerate(masks[:4]):
            if pct(f"DT{i}") > best_date:
                best_date, best_mask = pct(f"DT{i}"), mk
        if field.startswith("BYTES_"):
            inferred, conf = "UNKNOWN", 0.0
            risk = "UNMAPPED_DATA" if nn else None
            verdict = (f"no transform reads bytes {st['pos']}-"
                       f"{st['pos']+st['len']-1}; non-blank in {nn:,} blobs"
                       if nn else "filler (blank)")
        elif pct("FLAG") >= 98:
            inferred, conf, risk, verdict = "BOOLEAN_FLAG", pct("FLAG"), None, ""
        elif best_date >= 98:
            inferred, conf = f"DATE:{best_mask}", best_date
            risk = "CAST_UNSAFE" if conf < 100 else None
            verdict = f"{round(nn*(100-conf)/100):,} values fail mask" \
                if risk else ""
        elif pct("NUM_OK") >= 98:
            inferred, conf = "DECIMAL", pct("NUM_OK")
            risk = "CAST_UNSAFE" if conf < 100 else None
            verdict = f"{round(nn*(100-conf)/100):,} values fail NUMBER" \
                if risk else ""
        else:
            inferred, conf, risk, verdict = "STRING", 100.0, None, ""
        results.append(dict(
            field_name=field, pos_start=st["pos"], pos_len=st["len"],
            target_column=st["target"], inferred_type=inferred,
            conformance_pct=round(conf, 2), nonnull_rows=nn, total_rows=total,
            bad_rows=round(nn * (100 - conf) / 100) if conf < 100 else 0,
            mean_val=st.get("MEAN"), stddev_val=st.get("STDDEV"),
            date_mask=best_mask if inferred.startswith("DATE") else None,
            risk=risk, verdict=verdict))
    return results



def profile_text(scur, qtab, clob_col, sample_rows=0):
    """Census for free-text CLOBs (no parse spec): emptiness, length
    distribution, and — when content is low-cardinality — the top values.
    Returns rows shaped like parsed-field profiles so storage/UI reuse."""
    src = (f"(SELECT * FROM {qtab} WHERE ROWNUM <= {sample_rows})"
           if sample_rows else qtab)
    c = f'"{clob_col}"'
    scur.execute(f"""
        SELECT COUNT(*),
               COUNT(CASE WHEN {c} IS NOT NULL THEN 1 END),
               SUM(CASE WHEN DBMS_LOB.GETLENGTH({c}) <= 4000
                        THEN 1 ELSE 0 END),
               ROUND(AVG(DBMS_LOB.GETLENGTH({c})), 1),
               MAX(DBMS_LOB.GETLENGTH({c})),
               APPROX_COUNT_DISTINCT(
                   CAST(DBMS_LOB.SUBSTR({c}, 120, 1) AS VARCHAR2(480)))
        FROM {src}""")
    total, nn, fits4k, lavg, lmax, ndv = scur.fetchone()
    rows = [dict(field_name="TEXT_PROFILE", pos_start=None, pos_len=None,
                 target_column=None, inferred_type="TEXT",
                 conformance_pct=None, nonnull_rows=nn, total_rows=total,
                 bad_rows=0, mean_val=lavg, stddev_val=None, date_mask=None,
                 risk=("CLOB_OVERSIZED_TYPE" if (lmax or 0) <= 100 else None),
                 verdict=(f"avg len {lavg} · max {lmax} · ~{ndv} distinct"
                          + (f" · fits VARCHAR2: {fits4k}/{nn}"
                             if nn else "")
                          + (" — short text stored as CLOB; convert to "
                             "VARCHAR2 in target" if (lmax or 0) <= 100
                             else "")))]
    if ndv and nn and ndv <= 50:
        try:
            scur.execute(f"""
                SELECT v, cnt FROM (
                  SELECT CAST(DBMS_LOB.SUBSTR({c}, 120, 1)
                              AS VARCHAR2(480)) v, COUNT(*) cnt
                  FROM {src} WHERE {c} IS NOT NULL
                  GROUP BY CAST(DBMS_LOB.SUBSTR({c}, 120, 1)
                                AS VARCHAR2(480))
                  ORDER BY cnt DESC)
                WHERE ROWNUM <= 10""")
            for i, (v, cnt) in enumerate(scur.fetchall(), 1):
                rows.append(dict(
                    field_name=f"VALUE_{i:02d}", pos_start=None,
                    pos_len=None, target_column=None,
                    inferred_type="TEXT_VALUE", conformance_pct=None,
                    nonnull_rows=cnt, total_rows=nn, bad_rows=0,
                    mean_val=None, stddev_val=None, date_mask=None,
                    risk=None,
                    verdict=(v or "").strip()[:380]))
            rows[0]["verdict"] += (" · standardized phrase set — candidate "
                                   "reference table / code list")
        except Exception as e:                              # noqa: BLE001
            log.warning("text value census failed %s.%s: %s",
                        qtab, clob_col, str(e)[:80])
    return rows

# ---------------------------------------------------------------------------
def inspect(data_source, table, clob=None, sample_rows=0, run_id=None):
    run_id = run_id or f"CLB{dt.datetime.now():%Y%m%d_%H%M%S}"
    cconn = _catalog()
    ccur = cconn.cursor()
    ccur.execute("""INSERT INTO recon_runs
        (run_id, data_source, run_type, scope, status, step)
        VALUES (:1, :2, 'CLOB', :3, 'RUNNING', 'discovering CLOB columns')""",
        [run_id, data_source, table])
    cconn.commit()
    try:
        dictionary = load_dictionary(ccur)
        masks = list(_DEFAULT_MASKS)
        for raw, _ in dictionary.values():
            m = _oracle_mask(raw)
            if m and m not in masks:
                masks.append(m)

        sconn, own = _source_conn(data_source)
        scur = sconn.cursor()
        qtab = _phys(_qual(data_source, "STG1", table))
        _col_types(scur, qtab)          # populates resolution cache
        qtab = _phys(qtab)
        clobs = [clob.upper()] if clob else discover_clobs(scur, qtab)
        if not clobs:
            raise RuntimeError(f"no CLOB columns in {qtab}")
        log.info("CLOB columns in %s: %s", qtab, clobs)
        registry = load_registry(ccur)

        for cc in clobs:
            ccur.execute("UPDATE recon_runs SET step = :s WHERE run_id = :r",
                         {"s": f"inspecting {cc}", "r": run_id})
            cconn.commit()
            meta = blob_metadata(scur, qtab, cc)
            spec, unresolved = parse_spec_from_lineage(
                ccur, data_source, table, cc)
            gaps = (find_gaps(spec, int(meta["len_mode"]))
                    if spec and meta["len_mode"] else [])
            gaps_note = ",".join(f"{a}-{b}" for a, b in gaps) or None
            ccur.execute("""INSERT INTO recon_clob_profile
                (run_id, data_source, table_name, column_name, blob_count,
                 len_min, len_max, len_avg, len_mode, len_uniform_pct,
                 truncated_cnt, structure, spec_fields, spec_resolved,
                 spec_coverage_bytes, unmapped_regions,
                 referenced_by_transform)
                VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,
                        :15,:16,:17)""",
                [run_id, data_source, table, cc, meta["blob_count"],
                 meta["len_min"], meta["len_max"], meta["len_avg"],
                 meta["len_mode"], meta["len_uniform_pct"],
                 meta["truncated_cnt"], meta["structure"],
                 len(spec) + len(unresolved), len(spec),
                 sum(ln for _, _, ln in spec), gaps_note,
                 "Y" if (spec or unresolved) else "N"])
            cconn.commit()
            log.info("%s: %s, len mode %s (%.1f%% uniform), spec %d/%d, "
                     "gaps %s", cc, meta["structure"], meta["len_mode"],
                     meta["len_uniform_pct"] or 0, len(spec),
                     len(spec) + len(unresolved), gaps_note)
            reg = registry.get((table.upper(), cc)) \
                or registry.get((qtab.split(".")[-1].upper(), cc))
            suppress = bool(reg and any(h in reg["hint"]
                                        for h in _SUPPRESS_HINTS))
            fam = reg["family"] if reg else None
            if fam:
                meta["structure"] = reg["name"][:30]
            fields = []
            if fam == "json_parser":
                fields = profile_json(scur, qtab, cc, suppress)
            elif fam == "delimited_parser":
                fields = profile_delimited(scur, qtab, cc,
                                           reg.get("delim"), suppress)
            elif fam == "empty_handler":
                fields = profile_empty_check(scur, qtab, cc)
            elif meta["structure"] == "FIXED_WIDTH" and spec:
                fields = profile_fields(scur, qtab, cc, spec, gaps,
                                        masks, sample_rows)
            else:
                fields = profile_text(scur, qtab, cc, sample_rows)
                if suppress:
                    for f in fields:
                        if f["inferred_type"] == "TEXT_VALUE":
                            f["verdict"] = _mask(f["verdict"])
            if fields:
                for f in fields:
                    ccur.execute("""INSERT INTO recon_clob_fields
                        (run_id, table_name, clob_column, field_name,
                         pos_start, pos_len, target_column, inferred_type,
                         conformance_pct, nonnull_rows, total_rows, bad_rows,
                         mean_val, stddev_val, date_mask, risk, verdict)
                        VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,
                                :13,:14,:15,:16,:17)""",
                        [run_id, table, cc, f["field_name"], f["pos_start"],
                         f["pos_len"], f["target_column"], f["inferred_type"],
                         f["conformance_pct"], f["nonnull_rows"],
                         f["total_rows"], f["bad_rows"], f["mean_val"],
                         f["stddev_val"], f["date_mask"], f["risk"],
                         f["verdict"]])
                cconn.commit()
                log.info("  %d field/census rows recorded for %s",
                         len(fields), cc)
        if own:
            sconn.close()
        ccur.execute("""UPDATE recon_runs SET status = 'COMPLETE',
            finished_at = SYSTIMESTAMP, step = 'done' WHERE run_id = :r""",
            {"r": run_id})
        cconn.commit()
    except Exception as e:                                  # noqa: BLE001
        log.exception("clob inspect failed")
        ccur.execute("""UPDATE recon_runs SET status = 'FAILED',
            error_text = :e, finished_at = SYSTIMESTAMP
            WHERE run_id = :r""", {"e": str(e)[:1900], "r": run_id})
        cconn.commit()
    return run_id


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-source", default="PBDW")
    ap.add_argument("--table", required=True)
    ap.add_argument("--clob", default=None)
    ap.add_argument("--sample-rows", type=int, default=0)
    args = ap.parse_args()
    rid = inspect(args.data_source, args.table, args.clob, args.sample_rows)
    print(f"run {rid}")


if __name__ == "__main__":
    sys.exit(main())
