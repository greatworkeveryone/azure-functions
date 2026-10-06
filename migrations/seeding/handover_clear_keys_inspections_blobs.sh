#!/usr/bin/env bash
#
# handover_clear_keys_inspections_blobs.sh
#
# Blob-storage half of the RP-handover cleanup — run AFTER the SQL script
# (handover_clear_keys_inspections.sql) has cleared the DB rows. Deletes:
#
#   1. Every blob in the `key-photos` container — that container holds ONLY
#      key handover/checkout photos, so it is cleared wholesale.
#   2. Blobs under the `inspections/` prefix in the attachments container
#      (default `wr-attachments`) — that container is SHARED with work-request
#      attachments, so only specific prefixes are touched.
#   3. Blobs under the `po/` prefix in the same container — rendered Purchase
#      Order PDFs (po/{poId}.pdf), part of the cleared jobs domain.
#   4. Blobs under `attachments/jobs/` and `attachments/workRequests/` in the
#      same container — local uploads for the cleared jobs + WR mirror.
#
# NOT covered (no common prefix — the SQL script prints both lists in its run
# log before deleting the rows; delete those blobs individually if wanted):
#   - legacy-shaped attachment blob names outside the attachments/ prefixes
#     ("AttachmentBlob" in the run log)
#   - email attachment blobs ("EmailAttachmentBlobs", a JSON array per email)
#
# Defaults to a DRY RUN that lists what would be deleted. Pass --apply to
# actually delete.
#
# Usage:
#   ./handover_clear_keys_inspections_blobs.sh <storage-account-name> [--apply]
#
# Auth: uses your `az login` identity (--auth-mode login), which needs the
# "Storage Blob Data Contributor" role on the account. Alternatively export
# AZURE_STORAGE_CONNECTION_STRING and drop the --auth-mode/--account-name args
# by hand.

set -euo pipefail

ACCOUNT="${1:?Usage: $0 <storage-account-name> [--apply]}"
MODE="${2:-dry-run}"
ATTACHMENTS_CONTAINER="${ATTACHMENTS_CONTAINER_NAME:-wr-attachments}"

DRY_RUN_FLAG="--dry-run"
if [[ "$MODE" == "--apply" ]]; then
  DRY_RUN_FLAG=""
  echo ">>> APPLY mode — blobs WILL be deleted."
else
  echo ">>> Dry run — listing only. Re-run with --apply to delete."
fi

echo ""
echo "── 1/4 key-photos container (all blobs) ──────────────────────────────"
az storage blob delete-batch \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --source key-photos \
  $DRY_RUN_FLAG

echo ""
echo "── 2/4 $ATTACHMENTS_CONTAINER container, inspections/ prefix only ────"
az storage blob delete-batch \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --source "$ATTACHMENTS_CONTAINER" \
  --pattern 'inspections/*' \
  $DRY_RUN_FLAG

echo ""
echo "── 3/4 $ATTACHMENTS_CONTAINER container, po/ prefix (PO PDFs) ────────"
az storage blob delete-batch \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --source "$ATTACHMENTS_CONTAINER" \
  --pattern 'po/*' \
  $DRY_RUN_FLAG

echo ""
echo "── 4/4 $ATTACHMENTS_CONTAINER container, job + WR upload prefixes ────"
az storage blob delete-batch \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --source "$ATTACHMENTS_CONTAINER" \
  --pattern 'attachments/jobs/*' \
  $DRY_RUN_FLAG
az storage blob delete-batch \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --source "$ATTACHMENTS_CONTAINER" \
  --pattern 'attachments/workRequests/*' \
  $DRY_RUN_FLAG

echo ""
echo "Done."
