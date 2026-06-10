# SEI Accounting Transformation Pipeline
## BBH Capital Partners — Strategic Wealth Platform (SWP) Migration

---

## Table of Contents

1. [Business Context](#1-business-context)
2. [Architecture Overview](#2-architecture-overview)
3. [Repository Layout](#3-repository-layout)
4. [Data Model — Seeds and Reference Data](#4-data-model--seeds-and-reference-data)
5. [Feed Generation — How SEI Files Are Created](#5-feed-generation--how-sei-files-are-created)
6. [File Watcher — From Folder to Pipeline](#6-file-watcher--from-folder-to-pipeline)
7. [Airflow DAGs — Orchestration Layer](#7-airflow-dags--orchestration-layer)
8. [dbt Medallion — Transformation Layer](#8-dbt-medallion--transformation-layer)
9. [Dual Publish — PBDW and IMDW](#9-dual-publish--pbdw-and-imdw)
10. [Error Handling — Five Scenarios](#10-error-handling--five-scenarios)
11. [File Scenarios — Late Arrival, Backfill, Correction](#11-file-scenarios--late-arrival-backfill-correction)
12. [Setup and Running the Demo](#12-setup-and-running-the-demo)
13. [Environment Variables Reference](#13-environment-variables-reference)
14. [Makefile Reference](#14-makefile-reference)
15. [Oracle Compatibility Notes](#15-oracle-compatibility-notes)

---

## 1. Business Context

BBH Capital Partners is replacing its legacy portfolio accounting systems — FIS/Advent AddVantage and STAR — with SEI's Strategic Wealth Platform (SWP) as the new system of record for accounting data.

**The challenge.** SEI is an external platform hosted on Azure. BBH does not own the compute or storage. Data produced by SEI must be extracted, validated, transformed according to BBH's business rules, and loaded into two BBH-owned data warehouses that serve downstream consumers: risk systems, reporting dashboards, compliance teams, and client statement generation.

**What this pipeline does.** Every business day, SEI produces a feed file containing transaction records for all BBH-managed accounts. This pipeline:

- Detects when the file arrives in the SEI drop folder
- Classifies records as new transactions, late additions to historical dates, or corrections to previously bad data
- Validates data quality and compliance status before any transformation
- Applies BBH's accounting business rules through a three-layer dbt medallion
- Publishes shaped datasets to two destination databases — PBDW for portfolio reporting and IMDW for instrument analytics
- Handles every failure mode with a decision tree: retry, auto-fix, skip with alert, or halt and escalate

**The three account types in the demo.** ACC001 (Capital Growth Fund I) and ACC002 (Strategic Wealth Fund II) are active accounts. ACC003 (BBH Balanced Portfolio) is suspended pending compliance review — it is present in feeds but excluded from transformation and publish layers. This reflects a real production scenario where a subset of accounts may be under regulatory hold.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  SEI SWP (Azure-hosted)                                             │
│  Drops feed CSV files to shared volume once per business day        │
└─────────────────────────┬───────────────────────────────────────────┘
                          │  /opt/app_root/webfs/SEI/incoming/
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SEIFolderSensor (Airflow custom sensor)                            │
│  Polls incoming/ every 30s                                          │
│  Classifies file by record_type column content                      │
│  Moves to processing/ atomically (prevents double-pickup)           │
│  Pushes metadata to XCom                                            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
              ┌───────────┼────────────┐
              ▼           ▼            ▼
          NORMAL      LATE_ADD    AMENDED_BY_CLIENT
          records     records     records
          (bronze)  (backfill)   (SCD2 + alert)
              └───────────┼────────────┘
                          │  (ALL parallel, independent)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  dbt Medallion                                                      │
│                                                                     │
│  Staging  →  Bronze  →  Silver  →  Gold                            │
│  (views)    (raw)     (conformed)  (aggregated)                    │
│                                                                     │
│  Oracle-compatible SQL throughout                                   │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
           ┌───────────┴────────────┐
           ▼                        ▼
┌──────────────────┐    ┌──────────────────────────┐
│  PBDW            │    │  IMDW                    │
│  BBH_PBDW schema │    │  BBH_IMDW schema         │
│                  │    │                          │
│  Portfolio and   │    │  Instrument and Market   │
│  Business Data   │    │  Data Warehouse          │
│  Warehouse       │    │                          │
│  BI / Reporting  │    │  Risk / Quant / IBOR     │
└──────────────────┘    └──────────────────────────┘
```

**Key design principles.**

- The gold layer runs once. Both PBDW and IMDW read from the same gold models — there is no duplicate transformation work.
- PBDW and IMDW publish tasks run in parallel and are fully independent. A failure writing to PBDW does not block IMDW.
- `max_active_runs=1` on the file watcher DAG guarantees sequential file processing in date order — May 1 fully completes before May 2 starts.
- Every file is moved atomically from `incoming/` to `processing/` before the pipeline starts. If the DAG fails, the file moves to `failed/` and no data is left in an ambiguous state.
- All SQL is Oracle-compatible: `1/0` instead of `TRUE/FALSE`, `TO_DATE()` for date literals, `CAST()` instead of `::` type syntax, `ORA_HASH` for surrogate keys.

---

## 3. Repository Layout

```
sei-accounting-demo/
│
├── run_demo.sh                        ← single entry point: zero to running
│
├── scripts/
│   ├── setup_sei_folder.sh            ← create folder structure + populate feeds
│   ├── generate_feeds.py              ← generate feed CSVs → write directly to incoming/
│   ├── setup.sh                       ← Airflow DB init + DAG deployment
│   ├── load_seeds.sh                  ← dbt seed loader
│   └── demo_curl_errors.sh            ← all curl demo commands automated
│
├── dags/
│   ├── sei_file_watcher.py            ← PRIMARY: event-driven file watcher DAG
│   ├── sei_accounting_transform.py    ← API-based extract + medallion DAG
│   ├── sei_file_ingestion_with_backfill.py  ← file scenarios demo DAG
│   ├── sei_dual_publish.py            ← PBDW + IMDW fan-out DAG
│   └── sensors/
│       ├── sei_folder_sensor.py       ← custom BaseSensorOperator
│       └── sei_file_parser.py         ← CSV reader + record type splitter
│
├── dbt_project/
│   ├── dbt_project.yml                ← materialization + seed config
│   ├── profiles.yml.example           ← dev/oracle/snowflake/pbdw/imdw targets
│   ├── models/
│   │   ├── staging/                   ← views over seeds (contract boundary)
│   │   │   ├── stg_sei_transactions.sql
│   │   │   ├── stg_sei_nav.sql
│   │   │   ├── stg_sei_accounts.sql
│   │   │   └── stg_sei_corrections.sql
│   │   ├── bronze/                    ← raw ingestion, incremental
│   │   │   └── bronze_sei_transactions.sql
│   │   ├── silver/                    ← business rules, conformed types
│   │   │   ├── silver_transactions_conformed.sql
│   │   │   └── silver_transactions_scd2.sql
│   │   ├── gold/                      ← account-level aggregations
│   │   │   └── gold_portfolio_performance.sql
│   │   └── publish/
│   │       ├── pbdw/                  ← PBDW destination models
│   │       │   ├── pbdw_portfolio_positions.sql
│   │       │   ├── pbdw_accounting_journal.sql
│   │       │   └── pbdw_account_summary.sql
│   │       └── imdw/                  ← IMDW destination models
│   │           ├── imdw_instrument_holdings.sql
│   │           ├── imdw_transaction_detail.sql
│   │           └── imdw_nav_timeseries.sql
│   └── seeds/
│       ├── reference/                 ← static dimension data (load once)
│       │   ├── seed_accounts.csv          5 accounts
│       │   ├── seed_security_master.csv   12 securities with CUSIP/ISIN/SEDOL
│       │   ├── seed_transaction_type_map.csv  13 SEI type → BBH canonical mappings
│       │   ├── seed_error_catalog.csv     15 error codes with handling rules
│       │   └── seed_nav_history.csv       20 NAV records May 1–15
│       └── staging/                   ← transactional seed data for demo
│           ├── seed_stg_transactions.csv  17 transactions (includes bad records)
│           ├── seed_corrections_manifest.csv  5 correction diffs
│           ├── seed_late_adds.csv         4 late-add records
│           └── seed_audit_trail.csv       4 pre-loaded audit entries
│
├── feeds/                             ← local archive (generate_feeds.py --keep-local)
│   ├── daily/                         ← NORMAL daily transaction feeds
│   ├── corrections/                   ← AMENDED_BY_CLIENT corrective feeds
│   ├── late_adds/                     ← LATE_ADD backfill feeds
│   └── bad_data/                      ← original bad records reference
│
├── mock_sei_api/
│   ├── app.py                         ← Flask mock with 8 endpoints + error injection
│   └── file_routes.py                 ← feed status, correction manifest, audit log
│
├── sei_client/
│   └── client.py                      ← retry, circuit breaker, error classifier
│
├── demo_runner.py                     ← interactive API error scenario walkthrough
├── demo_file_scenarios.py             ← interactive file scenario walkthrough
├── docs/
│   └── sei_accounting_visualization.html  ← executive presentation (open in browser)
├── .env.example                       ← all environment variables
├── Makefile                           ← dev shortcuts
└── requirements.txt
```

---

## 4. Data Model — Seeds and Reference Data

Seeds are static CSV files loaded into the database via `dbt seed`. They represent data that exists before any SEI feed arrives and remains stable across pipeline runs. Seeds are loaded once and refreshed only when the underlying reference data changes.

### Reference Seeds (load once, rarely change)

**`seed_accounts.csv`** — 5 accounts: ACC001 through ACC005. Each account has a name, type, benchmark index, inception date, AUM, and risk tier. ACC003 is marked SUSPENDED — this drives the compliance branch in error handling.

```
ACC001  Capital Growth Fund I       EQUITY_LONG_ONLY   ACTIVE    S&P500         $4.25M
ACC002  Strategic Wealth Fund II    BALANCED           ACTIVE    MSCI World     $8.10M
ACC003  BBH Balanced Portfolio      BALANCED           SUSPENDED MSCI World     $2.75M
ACC004  Alpha Opportunities Fund    EQUITY_LONG_SHORT  ACTIVE    Russell 2000   $12.5M
ACC005  Fixed Income Reserve        FIXED_INCOME       ACTIVE    Bloomberg Agg  $6.80M
```

**`seed_security_master.csv`** — 12 securities including equities (AAPL, MSFT, NVDA, GOOGL, JNJ, BRK.B), ETFs (VTI, SPY, AGG, IEF), a Treasury bond, and CASH. Each row carries ISIN, CUSIP, SEDOL, sector, sub-sector, exchange, and price source. This is the join target in the silver model that enriches raw ticker symbols with full instrument reference data.

**`seed_transaction_type_map.csv`** — 13 rows mapping every SEI transaction type code (BUY, SELL, DIV, INT, FEE, etc.) to BBH's canonical type name, accounting leg (DEBIT or CREDIT), GL category, and GL account code. This is the business rule table that makes the silver conformed model database-agnostic — changing how a transaction type is classified means updating one seed row, not editing SQL.

**`seed_error_catalog.csv`** — 15 error codes with their severity level (TRANSIENT, WARN, ERROR, CRITICAL), whether they are auto-fixable, what fix action to apply, the SLA in minutes, which team receives the escalation, and whether NYDFS notification is required. The API client and Airflow tasks read this catalog to decide how to respond to each error rather than having that logic hardcoded.

**`seed_nav_history.csv`** — 20 NAV records covering ACC001 and ACC002 daily from May 1 through May 15, plus ACC003 and ACC004 spot records. Each row includes NAV in USD, shares outstanding, NAV per share, benchmark and portfolio return percentages, YTD return, and cash balance. ACC003's May 15 row has null NAV — the pipeline detects this and flags the account as excluded from gold.

### Staging Seeds (transactional demo data)

**`seed_stg_transactions.csv`** — 17 transaction records covering all five accounts from May 1 through May 15. This includes the two intentionally bad records that Scenario C corrects: TX10003 (dividend with wrong amount of $1,250 instead of $1,875) and TX20003 (sale with status FAILED and error code PRICE_STALE instead of SETTLED). These bad records are what the SCD2 model expires and replaces.

**`seed_corrections_manifest.csv`** — 5 rows documenting each field-level correction: which tx_id, which field changed, original value, corrected value, delta percentage, whether the change is material, and who authorized it. This is the source of truth for the SCD2 correction flow.

**`seed_late_adds.csv`** — 4 late-add records with their original transaction dates (the historical partitions they belong to), the feed date when they finally arrived, the reason for omission, and how many days late they were.

**`seed_audit_trail.csv`** — 4 pre-loaded audit entries covering the two corrections and two backfill inserts from the demo scenarios. Every action taken against data in the pipeline is recorded here permanently — the table is append-only and records are never deleted.

---

## 5. Feed Generation — How SEI Files Are Created

In production, SEI generates the feed files on their infrastructure and drops them to the shared volume mount at `/opt/app_root/webfs/SEI/incoming/`. In the demo environment, `scripts/generate_feeds.py` simulates this by generating realistic CSV files with the same structure and writing them directly to the incoming folder.

### Running the generator

```bash
# Generate all feeds → straight into incoming/ (default behaviour)
python3 scripts/generate_feeds.py

# Custom incoming folder
python3 scripts/generate_feeds.py --incoming /opt/app_root/webfs/SEI/incoming

# Specific scenario only
python3 scripts/generate_feeds.py --scenario A   # late file only
python3 scripts/generate_feeds.py --scenario B   # late adds only
python3 scripts/generate_feeds.py --scenario C   # corrections only

# Custom date (simulating today's feed)
python3 scripts/generate_feeds.py --date 2025-06-10

# Keep a local copy in feeds/ as well
python3 scripts/generate_feeds.py --keep-local
```

### What gets generated

The generator produces these files in date order — the sensor will process them oldest first:

```
sei_daily_feed_20250501.csv   ← May 1: ACC001 buys AAPL, ACC005 buys AGG
sei_daily_feed_20250502.csv   ← May 2: ACC002 buys BRK.B
...                           ← May 3 through May 14: daily NORMAL records
sei_daily_feed_20250515.csv   ← May 15: NORMAL + LATE_ADD + AMENDED (main demo file)
sei_daily_feed_20250516_LATE.csv  ← Scenario A: same content, arrives after SLA
sei_late_add_feed_20250516.csv    ← Scenario B: LATE_ADD records only
sei_corrective_feed_20250516.csv  ← Scenario C: AMENDED_BY_CLIENT records only
```

### Feed file structure

Every daily feed is a CSV with these columns:

```
tx_id            Unique transaction identifier  (e.g. TX10010)
account_id       BBH account reference          (ACC001, ACC002, etc.)
tx_date          Transaction date               (YYYY-MM-DD)
tx_type          SEI transaction type code      (BUY, SELL, DIV, INT, FEE, etc.)
security         Security ticker                (AAPL, NVDA, CASH, etc.)
units            Number of units (0 for income/fee transactions)
price            Price per unit in USD
amount_usd       Total amount (negative for fees and outflows)
status           Transaction status             (SETTLED, PENDING, FAILED, BLOCKED)
error_code       Error code if present          (PRICE_STALE, ACCOUNT_SUSPENDED, etc.)
record_type      Classification flag            (NORMAL, LATE_ADD, AMENDED_BY_CLIENT)
amendment_reason Reason for amendment if applicable
authorized_by    Who authorized the change
feed_version     Feed schema version            (1.0 for originals, 2.0 for corrections)
```

### The May 15 mixed file — the main demo feed

`sei_daily_feed_20250515.csv` deliberately contains all three record types in a single file. This is realistic — SEI may bundle corrections and late additions into the same daily drop rather than issuing separate files. The sensor detects this, classifies the file as `full_mixed`, and activates all three handlers simultaneously.

```
TX10010  ACC001  2025-05-15  BUY   NVDA   NORMAL            ← new purchase
TX10011  ACC001  2025-05-15  DIV   AAPL   NORMAL            ← new dividend
TX20010  ACC002  2025-05-15  SELL  VTI    NORMAL            ← new sale
TX10003B ACC001  2025-05-03  FEE   CASH   LATE_ADD          ← backfill to May 3 partition
TX20005B ACC002  2025-05-07  INT   CASH   LATE_ADD          ← backfill to May 7 partition
TX10003  ACC001  2025-05-07  DIV   JNJ    AMENDED_BY_CLIENT ← correct $1,250 → $1,875
TX20003  ACC002  2025-05-12  SELL  BRK.B  AMENDED_BY_CLIENT ← correct FAILED → SETTLED
```

---

## 6. File Watcher — From Folder to Pipeline

The file watcher is the entry point for all production data. It consists of two components: a custom Airflow sensor that polls the folder, and a DAG that orchestrates the full processing pipeline once a file is detected.

### Folder structure

```
/opt/app_root/webfs/SEI/
  incoming/              ← SEI (or generate_feeds.py) writes here
  processing/            ← sensor moves file here atomically before processing
  processed/
    2025-05-01/          ← successful files archived by date
    2025-05-15/
  failed/                ← sei_daily_feed_20250515_FAILED_20250516T083012.csv
```

### The sensor — `SEIFolderSensor`

On every poke interval (30 seconds):

1. Lists all `.csv` files in `incoming/`, sorted by the `YYYYMMDD` string in the filename. This guarantees date order regardless of filesystem modification time.
2. Selects the oldest file.
3. Opens it and reads the `record_type` column across all rows. Determines which of the three record types are present.
4. Classifies the file: `daily_only`, `daily_with_backfill`, `daily_with_correction`, `full_mixed`, `backfill_only`, or `correction_only`.
5. Moves the file from `incoming/` to `processing/` using `shutil.move()` — this is atomic on the same filesystem and prevents any other DAG run from picking the same file.
6. Pushes the metadata dictionary to XCom under key `sei_file_meta`.
7. Returns `True` — the sensor task succeeds and the DAG proceeds.

If `incoming/` is empty, the sensor returns `False` and keeps polling.

### Processing order guarantee

`max_active_runs=1` on the DAG combined with the sensor's oldest-first sort means files are always processed in date order. If three files are waiting — May 1, May 3, May 7 — May 1 runs to completion (including PBDW and IMDW publish), then May 3 starts, then May 7. The DAG re-triggers on its 2-minute schedule and the sensor picks the next oldest file each time.

### Branch routing

After parsing, a `BranchPythonOperator` returns a list of task IDs — whichever handlers are needed for the record types in that file. All selected handlers run in parallel.

```
branch_on_content ──► process_normal_records    (if NORMAL records present)
                  ──► process_late_add_records  (if LATE_ADD records present)
                  ──► process_amended_records   (if AMENDED_BY_CLIENT records present)
```

All three can run simultaneously for a mixed file. The `write_audit_log` task waits for all of them with `TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS`.

### File lifecycle

```
Success:  incoming/ → processing/ → processed/YYYY-MM-DD/
Failure:  incoming/ → processing/ → failed/FILENAME_FAILED_YYYYMMDDTHHMMSS.csv
```

The failure move uses `TriggerRule.ONE_FAILED` so it only activates if any upstream task fails. The `end` task uses `TriggerRule.ALL_DONE` so it always runs and the DAG always closes cleanly regardless of outcome.

---

## 7. Airflow DAGs — Orchestration Layer

There are four DAGs in the project. They serve different purposes and are not all needed simultaneously for the demo.

### `sei_file_watcher` (primary production DAG)

Scheduled every 2 minutes. The sensor does the real work — the 2-minute schedule is just the outer loop that keeps the sensor re-activating after each file completes. This is the DAG to use for the main demo.

```
watch_incoming_folder (SEIFolderSensor, polls every 30s)
        │
parse_and_stage_file
        │
branch_on_content
        ├──► process_normal_records
        ├──► process_late_add_records
        └──► process_amended_records
                    │ (NONE_FAILED_MIN_ONE_SUCCESS)
             write_audit_log
                    │
             dbt_targeted_run
                    │
           ┌────────┴────────┐
    publish_to_pbdw    publish_to_imdw
           └────────┬────────┘
                    │ (ALL_DONE)
             pipeline_summary
                    │
      ┌─────────────┴─────────────┐
move_to_processed          move_to_failed
      └─────────────┬─────────────┘
                   end
```

### `sei_accounting_transform` (API-based DAG)

Used when demonstrating the SEI API error handling scenarios. Fetches accounts, transactions, and NAV directly from the mock API rather than from files. Includes the circuit breaker, retry, and auto-fix demonstrations.

```
start
  ├── fetch_accounts
  ├── fetch_transactions    ← injects 429 on 3rd call for retry demo
  └── fetch_nav             ← returns 422 for ACC003 suspended account
          │
     validate_data (POST /v1/pipeline/validate)
          │
  branch_on_validation
    ├── halt_pipeline        ← if CRITICAL errors found
    └── dbt_run_bronze → dbt_run_silver → dbt_run_gold → load_summary
```

### `sei_dual_publish` (destination fan-out DAG)

Triggered externally after the gold layer completes. Runs PBDW and IMDW publish in parallel with independent failure handling. Can be triggered for a single destination or both.

```
check_params (branch: both / pbdw_only / imdw_only)
        │
    fan_out
  ┌─────┴──────┐
test_pbdw   test_imdw
  │              │
publish_pbdw  publish_imdw
  │              │
validate_pbdw validate_imdw
  └─────┬──────┘
 publish_summary (ALL_DONE)
        │
       end
```

### `sei_file_ingestion_with_backfill` (scenario demo DAG)

Used for demonstrating the three file scenarios interactively without needing the full watcher infrastructure. Accepts `simulate_late_file` and `file_arrives_in_seconds` parameters for controlled demos.

---

## 8. dbt Medallion — Transformation Layer

The medallion has four tiers: staging, bronze, silver, and gold. Each tier has a specific responsibility and materialization strategy. Two additional publish tiers write to the destination databases.

### Staging (views — contract boundary)

Staging models are views that sit on top of the seeds and present data with the exact column names the bronze model expects. In production, these views would point at landing tables populated by the Airflow pipeline. In the demo, they point at the seed CSVs. This means the entire bronze-to-gold pipeline can run from seed data without any external dependencies.

The staging layer is the **schema contract boundary**. If SEI changes the format of their feeds, only the staging model changes. Everything downstream is insulated.

```sql
-- stg_sei_transactions.sql (simplified)
SELECT
    tx_id, account_id, date, type AS tx_type,
    security, CAST(units AS FLOAT), CAST(price AS FLOAT),
    CAST(amount AS FLOAT), status, error_code, record_type
FROM seed_stg_transactions
```

### Bronze (incremental — raw ingestion)

The bronze model ingests every record exactly as it arrived from SEI with zero transformation. Column names are aliased to internal conventions (`date` → `tx_date_raw`, `type` → `tx_type_raw`) but values are never modified. Audit columns are added: `_ingested_at`, `_dbt_run_at`, `_source_system`.

The incremental strategy is `delete+insert` partitioned by `tx_date_raw`. On a full refresh it loads everything; on subsequent runs it loads only records from the most recent partition forward.

### Silver (incremental — business rules)

The silver model applies BBH's accounting business rules:

**Type normalization.** SEI uses codes like `BUY`, `SELL`, `DIV`. The silver model joins the `seed_transaction_type_map` seed to convert these to BBH's canonical types (`PURCHASE`, `REDEMPTION`, `DIVIDEND`) and derives the accounting leg (`DEBIT` or `CREDIT`) and GL category.

**Status filtering.** Only `SETTLED` transactions pass through. `FAILED`, `BLOCKED`, and `PENDING` records are excluded. Records with unresolved error codes are also excluded. This means the silver layer contains only clean, actionable data.

**Security master enrichment.** The `seed_security_master` seed is joined on ticker to add ISIN, CUSIP, SEDOL, security name, asset class, and sector to every transaction.

**Double-entry derivation.** Based on the accounting leg, either `debit_amount` or `credit_amount` is set to `ABS(amount_usd)` and the other to zero. This makes GL reconciliation straightforward downstream.

**Data quality flags.** `is_cusip_missing` (1 if no CUSIP in security master) and `is_price_zero` (1 if price is zero for a trade type that should have a price) are computed as Oracle-compatible `NUMBER(1)` columns.

### Silver SCD2 (incremental — correction history)

A separate model handles SCD Type 2 corrections. When a corrective feed arrives:

1. The original row is expired: `is_current = 0`, `valid_to = correction_date`
2. The corrected row is inserted: `is_current = 1`, `valid_from = correction_date`, `valid_to = TO_DATE('9999-12-31', 'YYYY-MM-DD')`
3. The original bad row is never deleted — it remains in the table with `is_current = 0` for audit and reconciliation purposes

The surrogate key is generated using Oracle's `ORA_HASH` function on a concatenation of `tx_id`, `is_correction`, and `correction_date`.

### Gold (table — account-level aggregation)

The gold model joins silver transactions, the latest NAV per account, and the account dimension to produce one row per account with all performance metrics and transaction summaries.

Key columns produced:
- `current_nav` — latest NAV from `stg_sei_nav`
- `ytd_return_pct` — year-to-date return percentage
- `total_purchased`, `total_redeemed`, `total_dividends`, `total_fees` — aggregated amounts
- `net_cash_flow` — total credits minus total debits
- `fee_ratio_pct`, `dividend_yield_pct` — derived ratios
- `excluded_from_gold` — `1` if account has no NAV (e.g. ACC003 suspended)

The gold model is the shared source for both PBDW and IMDW. It runs once per pipeline execution regardless of how many destinations consume it.

---

## 9. Dual Publish — PBDW and IMDW

The publish layer contains six models split across two destination schemas. They `ref()` the gold and silver models — there is no duplication of transformation logic. The only difference between the two destinations is the shape of the output and the dbt `--target` used to execute them.

### PBDW — Portfolio and Business Data Warehouse

Designed for business consumers: portfolio managers, client reporting teams, Tableau and PowerBI dashboards.

**`pbdw_portfolio_positions`** — one row per account per security. Computes net units (purchases minus redemptions), market value, cost basis, unrealized P&L and P&L percentage, and weight as a percentage of account NAV. All account-level KPIs from gold are denormalized onto each position row so a BI tool can build a complete account view from a single table without joins.

**`pbdw_accounting_journal`** — one row per journal line. Each settled transaction produces two rows: one debit line and one credit line. A window function computes `tx_balance_check` (sum of debits minus credits per transaction) which should always equal zero — any non-zero value indicates a data problem. This is the GL-ready output consumed by the finance team for reconciliation.

**`pbdw_account_summary`** — one row per account. A snapshot as of the dbt run date containing current NAV, YTD return, total income broken down by dividends and interest, total fees, active trading days, unique securities held, and data quality flags. Used for executive dashboards and client statement generation.

### IMDW — Instrument and Market Data Warehouse

Designed for quantitative and risk consumers: risk systems, IBOR feeds, performance attribution, quant analytics.

**`imdw_instrument_holdings`** — one row per instrument (ticker) aggregated across all accounts. Shows total net units held firm-wide, total market value, cost basis, unrealized P&L, and how many accounts hold the instrument. Joined with the full security master for CUSIP, ISIN, SEDOL, sector classification, exchange, and country. Sorted by market value descending.

**`imdw_transaction_detail`** — one row per settled transaction, fully enriched with security master and account attributes. Incremental by `tx_date`. Adds `position_effect` (`LONG_OPEN`, `LONG_CLOSE`, `INCOME`, `OTHER`) and `effective_unit_price` for trade analytics. This is the input to IBOR reconciliation and trade cost analysis.

**`imdw_nav_timeseries`** — one row per account per NAV date. Uses `LAG()` window functions to compute day-over-day NAV change and daily return percentage. Also computes active return versus benchmark (`portfolio_return_pct - benchmark_return_pct`), cash weight as a percentage of NAV, and observation sequence number for time-series ordering. Incremental by `nav_date`.

### Running each destination separately

```bash
# PBDW only
dbt run --select publish.pbdw.* --target pbdw --profiles-dir . --project-dir .

# IMDW only
dbt run --select publish.imdw.* --target imdw --profiles-dir . --project-dir .

# Both — gold runs once, publish runs twice against separate targets
dbt run --select gold.*
dbt run --select publish.pbdw.* --target pbdw --profiles-dir . --project-dir .
dbt run --select publish.imdw.* --target imdw --profiles-dir . --project-dir .
```

---

## 10. Error Handling — Five Scenarios

The API client (`sei_client/client.py`) and Airflow tasks implement a decision tree for every error. The decision is made by looking up the error code in the SEI error catalog API (`GET /v1/errors/{code}`) and reading the `severity` and `auto_fixable` fields.

### Error decision tree

```
Error received
      │
      ├── severity=TRANSIENT?  →  Retry with exponential backoff + jitter
      │                            Circuit breaker records failure
      │                            Max 4 retries, delays 1s → 30s
      │
      ├── severity=CRITICAL?   →  Post alert → Halt entire pipeline
      │                            AirflowFailException raised
      │
      ├── auto_fixable=True?   →  POST /v1/errors/{code}/fix
      │     │                      Fix applied? → Continue
      │     └── Fix failed?    →  Post alert → Skip affected records
      │
      ├── severity=WARN?       →  Skip affected records, continue pipeline
      │                            Log warning, no alert
      │
      └── severity=ERROR?      →  Post alert → Skip affected account
                                   Other accounts continue normally
```

### The five specific scenarios

**Scenario 1 — Rate limit (TRANSIENT).** The mock API injects an HTTP 429 on the third consecutive call to ACC001's transaction endpoint. The client detects the `Retry-After` header, applies an exponential backoff delay, and retries. The circuit breaker records the failure. After a successful retry the circuit breaker resets. From the DAG's perspective the task succeeded — the retry is invisible.

**Scenario 2 — Price stale (WARN, auto-fixable).** ACC002's TX20003 arrives with `error_code=PRICE_STALE`. The pipeline calls `GET /v1/errors/PRICE_STALE` which returns `auto_fixable=true`. It then calls `POST /v1/errors/PRICE_STALE/fix` which returns `fix_applied=true` and `fix_action=REFRESH_PRICE_FEED`. The pipeline logs the fix and continues. TX20003 is reprocessed with a refreshed price.

**Scenario 3 — Account suspended (ERROR, not fixable).** ACC003 appears in the feed with status BLOCKED and `error_code=ACCOUNT_SUSPENDED`. The pipeline calls the error catalog which returns `auto_fixable=false`. It calls the fix endpoint which returns HTTP 409 with `escalation_required=true`. The pipeline posts an alert to `POST /v1/alerts` with the account ID and error details, then skips all ACC003 records. ACC001, ACC002, ACC004, and ACC005 continue processing normally.

**Scenario 4 — NAV calculation failure (ERROR).** `GET /v1/accounts/ACC003/nav` returns HTTP 422 with a full `error_detail` block explaining which prices are missing. The pipeline captures this in XCom, posts an alert, and excludes ACC003 from the gold layer. The `excluded_from_gold` column in gold is set to `1` for ACC003.

**Scenario 5 — Circuit breaker.** After three consecutive failures on the same endpoint group, the circuit breaker state transitions to OPEN. Subsequent calls are rejected immediately without hitting the API — `_error_type=CIRCUIT_OPEN` is returned. After 10 seconds the breaker transitions to HALF_OPEN and allows one probe call. A successful probe resets the breaker to CLOSED.

---

## 11. File Scenarios — Late Arrival, Backfill, Correction

### Scenario A — Late file arrival

The pipeline expects the SEI daily feed by 08:00 UTC. `check_sla_status` (a `BranchPythonOperator`) compares the current time to `SLA_HOUR` from the environment.

If the file is late: the `past_sla_alert` task fires, posting to `POST /v1/alerts` with the feed name, expected delivery time, minutes late, and grace period window. The pipeline then enters `wait_for_file` which polls `incoming/` on a 30-second interval for up to 2 hours.

When the file eventually arrives the sensor picks it up, moves it to `processing/`, and the pipeline resumes automatically. No manual restart, no ticket, no human intervention required.

To trigger in the demo: use `sei_daily_feed_20250516_LATE.csv` which sorts after the on-time files and can be dropped manually with `make drop-daily` while the sensor is running.

### Scenario B — Backfill (late adds)

A late-add record is a transaction that was omitted from an earlier feed — perhaps a fee that was not captured on May 3, or an interest accrual that failed to process on May 7. The record carries its original `tx_date` (May 3 or May 7) so the pipeline knows which historical partition it belongs to.

The `process_late_add_records` task:
1. Reads the `tx_date` (or `original_tx_date`) from each LATE_ADD record
2. Performs an existence check: `SELECT COUNT(*) FROM bronze WHERE tx_id = ?` (idempotent — safe to re-run)
3. Inserts missing records into the correct historical partition
4. Records each action (INSERTED or SKIPPED) in the backfill log
5. Pushes affected dates to XCom so `dbt_targeted_run` can scope its re-run

The dbt re-run is targeted: `dbt run --select silver_transactions_conformed gold_portfolio_performance --vars '{"dates": ["2025-05-03","2025-05-07"]}'` — only the affected partitions are reprocessed, not the full table.

### Scenario C — Bad data correction (SCD Type 2)

A corrective feed arrives with records flagged `AMENDED_BY_CLIENT`. The original bad records (TX10003 with wrong dividend amount, TX20003 with wrong status) are already in the database. The correction flow:

1. For each amended record, compute `amount_delta_pct = abs((new - old) / old) * 100`
2. If `amount_delta_pct > 1%` → material change → post `MATERIAL_AMENDMENT` alert and require ops sign-off before applying
3. Apply SCD2: `UPDATE SET is_current=0, valid_to=today WHERE tx_id=? AND is_current=1`
4. Insert corrected row: `is_current=1, valid_from=today, valid_to=TO_DATE('9999-12-31','YYYY-MM-DD')`
5. Append to the audit trail: tx_id, what changed, from what value to what value, delta percentage, who authorized it, when

The original bad rows are **never deleted**. They remain in the SCD2 table with `is_current=0` and can be queried at any time for audit, reconciliation, or regulatory review.

For TX10003: the dividend amount was $1,250 (wrong) and is corrected to $1,875 — a 50% delta. This is material. The pipeline posts an alert before applying the correction.

For TX20003: the status was `FAILED` with `error_code=PRICE_STALE` and is corrected to `SETTLED` with no error code. The amount does not change. The delta is 0%. This is non-material and is auto-processed.

---

## 12. Setup and Running the Demo

### Prerequisites

- Python 3.10+
- Airflow 3.2.1 (pre-installed in ODH VSCode workbench image)
- dbt-core with dbt-duckdb for dev target (or dbt-oracle for Oracle target)
- Access to `/opt/app_root/webfs/SEI/` folder (writable)

### Option 1 — Full end-to-end in one command

```bash
cd sei-accounting-demo

# Everything: deps, env, dbt seed, dbt run bronze→gold, mock API, feeds to incoming/
bash run_demo.sh

# With Airflow DAG deployment and DB init
bash run_demo.sh --with-airflow
```

### Option 2 — Step by step

```bash
# Step 1: Install dependencies
pip install flask requests dbt-core dbt-duckdb

# Step 2: Environment and dbt profiles
cp .env.example .env
cp dbt_project/profiles.yml.example dbt_project/profiles.yml

# Step 3: Load reference data into database
cd dbt_project && dbt seed --profiles-dir . --project-dir . && cd ..

# Step 4: Run the medallion
cd dbt_project
dbt run --select staging.*
dbt run --select bronze.*
dbt run --select silver.*
dbt run --select gold.*
dbt run --select publish.pbdw.*     # dev target = DuckDB
dbt run --select publish.imdw.*
cd ..

# Step 5: Create SEI folder structure and populate with feeds
bash scripts/setup_sei_folder.sh

# Step 6: Start Airflow (if not already running in ODH image)
airflow db migrate
airflow users create --username admin --password admin \
    --firstname BBH --lastname Demo --role Admin --email admin@bbh.demo
airflow scheduler &
airflow webserver --port 8080 &

# Step 7: Start mock API (for API error scenario demos)
python3 mock_sei_api/app.py &
```

### Demo: API error scenarios

```bash
# Interactive step-by-step walkthrough of all 5 error scenarios
python3 demo_runner.py

# All curl commands automated
bash scripts/demo_curl_errors.sh
```

### Demo: file watcher in action

```bash
# Watch all folders in real time
make watch-folder

# In another terminal, drop a file to trigger the sensor
make drop-daily        # mixed file: NORMAL + LATE_ADD + AMENDED
make drop-correction   # amendments only
make drop-late-add     # backfill only

# Generate a custom date feed
python3 scripts/generate_feeds.py --date 2025-06-10
```

### Demo: trigger DAGs manually

```bash
# API-based pipeline
airflow dags trigger sei_accounting_transform

# File watcher (waits for a file in incoming/)
airflow dags trigger sei_file_watcher

# Late file simulation
airflow dags trigger sei_file_ingestion_with_backfill \
    --conf '{"simulate_late_file": true, "file_arrives_in_seconds": 8}'

# Dual publish to PBDW and IMDW
airflow dags trigger sei_dual_publish

# Publish to one destination only
airflow dags trigger sei_dual_publish \
    --conf '{"target_pbdw": true, "target_imdw": false}'
```

---

## 13. Environment Variables Reference

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|---|---|---|
| `SEI_FILE_BASE` | `/opt/app_root/webfs/SEI` | Root of SEI file drop folder |
| `SEI_API_BASE_URL` | `http://localhost:5001` | Mock API base URL |
| `SEI_API_KEY` | `demo-key-bbh-001` | API authentication header |
| `SEI_SLA_HOUR` | `8` | Expected delivery hour in UTC (08:00) |
| `SEI_SLA_GRACE_MINS` | `60` | Grace period before hard timeout |
| `AIRFLOW_HOME` | `/opt/airflow` | Set by ODH image |
| `DBT_PROJECT_DIR` | `/opt/airflow/dbt_project` | Path to dbt project |
| `MOCK_SEI_API_PORT` | `5001` | Port for mock API |
| `ORACLE_HOST` | — | Oracle shared layer hostname |
| `ORACLE_USER` | — | Oracle username |
| `ORACLE_PASSWORD` | — | Oracle password |
| `ORACLE_SERVICE` | — | Oracle service name |
| `PBDW_HOST` | — | PBDW database hostname |
| `PBDW_USER` | — | PBDW writer username |
| `PBDW_PASSWORD` | — | PBDW writer password |
| `PBDW_SCHEMA` | `BBH_PBDW` | PBDW target schema |
| `IMDW_HOST` | — | IMDW database hostname |
| `IMDW_USER` | — | IMDW writer username |
| `IMDW_PASSWORD` | — | IMDW writer password |
| `IMDW_SCHEMA` | `BBH_IMDW` | IMDW target schema |

---

## 14. Makefile Reference

```
make install              Install flask + requests
make api                  Start mock SEI API (foreground)
make api-bg               Start mock SEI API (background)
make api-stop             Stop background API
make demo                 Interactive API error scenario demo
make demo-file            Interactive file scenario demo
make demo-errors          All curl commands automated
make airflow-init         Create Airflow DB + admin user
make airflow-up           Start scheduler + webserver
make deploy-dags          Copy all DAGs to AIRFLOW_HOME/dags
make deploy-watcher-dag   Deploy sei_file_watcher + sensors only
make trigger-dag1         Trigger sei_accounting_transform
make trigger-dag2         Trigger sei_file_ingestion_with_backfill
make trigger-dag2-late    With simulate_late_file=true
make trigger-publish      Trigger sei_dual_publish (both destinations)
make trigger-publish-pbdw-only  PBDW only
make trigger-publish-imdw-only  IMDW only
make setup-sei-folder     Create folder structure + populate incoming/
make watch-folder         Live folder monitoring (watch command)
make drop-daily           Drop mixed feed file to incoming/
make drop-correction      Drop AMENDED-only file to incoming/
make drop-late-add        Drop LATE_ADD-only file to incoming/
make generate-feeds       Run generate_feeds.py --scenario all
make load-seeds           Generate feeds + dbt seed
make dbt-seed             Run dbt seed (all)
make dbt-run              Run full medallion (bronze→silver→gold)
make dbt-run-pbdw         Run PBDW publish models
make dbt-run-imdw         Run IMDW publish models
make dbt-run-all-targets  Full pipeline: medallion + pbdw + imdw
make dbt-test             Run dbt tests
make lint                 ruff + black check
make clean                Remove caches and temp files
```

---

## 15. Oracle Compatibility Notes

All SQL models are written for Oracle compatibility. The following conventions apply throughout:

**Boolean values.** Oracle has no BOOLEAN data type. All boolean flags use `NUMBER(1)` with `1` for true and `0` for false. This applies to SQL (`CASE WHEN ... THEN 1 ELSE 0 END`) and to seed CSV values (the header may read `is_active` but values are `1` and `0`). dbt `column_types` in `dbt_project.yml` specifies `"NUMBER(1)"` for all boolean seed columns.

**Date literals.** Bare string dates like `'2000-01-01'` compared to Oracle DATE columns cause implicit conversion that can fail or produce wrong results. All date literals use `TO_DATE('2000-01-01', 'YYYY-MM-DD')` explicitly.

**Type casting.** PostgreSQL-style `::` casting syntax (`value::DATE`, `NULL::VARCHAR`) does not exist in Oracle. All casts use standard SQL: `CAST(value AS DATE)`, `CAST(NULL AS VARCHAR2(100))`.

**Current date and timestamp.** `CURRENT_DATE()` with parentheses throws `ORA-00923` in Oracle. Use `CURRENT_DATE` (no parentheses). `CURRENT_TIMESTAMP` works in both.

**Surrogate keys.** `dbt_utils.generate_surrogate_key` uses MD5 which requires the `dbt_utils` package and has inconsistent Oracle support. The SCD2 model uses `ORA_HASH` on a concatenated key string instead — a built-in Oracle function with no external dependencies.

**GRANT syntax.** Oracle GRANT syntax is `GRANT SELECT ON table TO role_name` — no `ROLE` keyword. The post-hooks in publish models use the Oracle form.

**Incremental strategy.** Both bronze and silver use `delete+insert` incremental strategy. Oracle supports this natively via dbt-oracle. The `merge` strategy used in the SCD2 model also works with dbt-oracle using the `merge_update_columns` config to limit which columns are updated on match.
