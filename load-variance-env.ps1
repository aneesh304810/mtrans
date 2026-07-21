# ============================================================================
# load-variance-env.ps1 — Variance 360 environment variables (local/dev)
#
# Usage (dot-source so vars land in your current session):
#   . .\load-variance-env.ps1
#
# Then start the API from the same shell:
#   cd api ; uvicorn app.main:app --reload
# Or run the ingestion CLI:
#   python -m ingestion.variance_ingest full --data-source PBDW
#
# NOTE: for OpenShift, put these in a Secret/ConfigMap instead — this script
# is for local development only. Do not commit real passwords.
# ============================================================================

# ---- Oracle Client for thick mode (required: BBH servers mandate Native
# Network Encryption -> DPY-3001 in thin mode). Point at the folder that
# contains oci.dll (Instant Client or full client).
$env:CP_ORACLE_CLIENT_DIR = "C:\oracle\instantclient_19_25"                  # -- EDIT

# ---- CP Catalog (SILVER) — where legacy_lineage lives and RECON_* is written
# Same variable the API already uses (app/db.py).
$env:CP_CATALOG_DB_DSN = "silver_user:CHANGE_ME@silver-host:1521/silversvc"   # -- EDIT

# ---- PBDW source warehouse (where the stage tables are profiled) ----------
$env:CP_VAR_PBDW_DSN = "pbdw_ro:CHANGE_ME@pbdw-host:1521/pbdwsvc"             # -- EDIT host/service
# Actual schema owners: staging chain in PBDWSTG, final tables in PBDWAPP.
$env:CP_VAR_PBDW_SCHEMA_SRC  = "PBDWSTG"
$env:CP_VAR_PBDW_SCHEMA_STG1 = "PBDWSTG"
$env:CP_VAR_PBDW_SCHEMA_STG2 = "PBDWSTG"
$env:CP_VAR_PBDW_SCHEMA_DWH  = "PBDWAPP"

# ---- IMDS source warehouse ------------------------------------------------
$env:CP_VAR_IMDS_DSN = "imds_ro:CHANGE_ME@imds-host:1521/imdssvc"             # -- EDIT
$env:CP_VAR_IMDS_SCHEMA_SRC  = "IMDS_SRC"                                      # -- EDIT
$env:CP_VAR_IMDS_SCHEMA_STG1 = "IMDS_STG"                                      # -- EDIT
$env:CP_VAR_IMDS_SCHEMA_STG2 = "IMDS_STG"                                      # -- EDIT
$env:CP_VAR_IMDS_SCHEMA_DWH  = "IMDS"                                          # -- EDIT

# ---- Optional: leave a source's DSN empty to profile it through the SILVER
# connection instead (requires synonyms / same instance):
#   Remove-Item Env:CP_VAR_IMDS_DSN

# ---- UI dev server (Vite) — API base for local runs -----------------------
$env:VITE_API_BASE = "http://localhost:8000"                                   # -- EDIT if different

Write-Host ""
Write-Host "Variance 360 environment loaded:" -ForegroundColor Green
Get-ChildItem Env: | Where-Object { $_.Name -like "CP_VAR_*" -or
    $_.Name -eq "CP_CATALOG_DB_DSN" -or $_.Name -eq "VITE_API_BASE" } |
  ForEach-Object {
    # mask anything between ':' and '@' (the password) when printing
    $v = $_.Value -replace "(:)[^@]+(@)", '$1****$2'
    Write-Host ("  {0} = {1}" -f $_.Name, $v)
  }
Write-Host ""
Write-Host "Reminder: dot-source this script ( . .\load-variance-env.ps1 )" -ForegroundColor Yellow
Write-Host "or the variables will vanish with the child process." -ForegroundColor Yellow
