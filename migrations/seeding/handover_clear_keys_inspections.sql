-- handover_clear_keys_inspections.sql
--
-- One-off RP-handover cleanup: wipes ALL data in the Keys, Inspections and
-- Jobs domains so those features start empty for Randazzo Properties.
--
--   Keys domain        : Keys (including soft-deleted rows), KeyCheckoutBatches,
--                        KeyCheckouts
--   Inspections domain : Inspections + cascading tree (levels → contributors,
--                        rooms → points → attachments), plus the non-cascading
--                        side tables (InspectionRaisedJobs, InspectionMergeSources,
--                        InspectionOperationLog)
--   Jobs domain        : Jobs + cascading children — JobEvents (the activity
--                        feed), Quotes (+ quote-attachment links),
--                        PurchaseOrders (+ PO-attachment links), Payments,
--                        JobInvoices, JobRequestedContractors — plus the
--                        non-FK job pointers: PlannerTasks rows with
--                        EntityType='job' and Attachments.JobID (job-only
--                        rows deleted, WR-linked rows unlinked)
--   Work requests      : the local myBuildings mirror (WorkRequests +
--                        Invoices), the app-local overlay edits
--                        (WorkRequestOverrides), ALL remaining Attachments
--                        rows (local uploads for WRs/jobs), and
--                        Buildings.WRsLastSyncedAt reset to NULL. WRs are a
--                        SYNCED MIRROR — after this clear, run
--                        POST /api/syncAllWorkRequests (or let the timer /
--                        screen visits re-pull per building) and RP gets a
--                        CLEAN re-import of current myBuildings data: no
--                        local edits, no local uploads. WRs not modified in
--                        myBuildings within the sync window (last 2 years)
--                        will NOT come back.
--   Incoming domain    : Emails (the intake queue) + EmailReplies. A single
--                        synthetic WATERMARK row is inserted after the wipe —
--                        graphNotification computes its mailbox sync window
--                        as MAX(ReceivedAt) FROM Emails and falls back to
--                        "beginning" on an empty table, so without it the
--                        first inbound mail would re-ingest the ENTIRE
--                        mailbox history. The row is invisible to the queue,
--                        the AI parser, and the flagged views. Do not delete
--                        it until a real email lands after the clear.
--
-- What SURVIVES: Contractors, Timesheets, Buildings, the whole tenancy
-- register, and everything else outside the domains above. Clearing the
-- job/WR pointers on surviving tables is not optional — identities are
-- reseeded, so RP's new records recycle old IDs and any stale pointer would
-- silently attach old data to them.
--
-- MS Planner itself is NOT touched — job-update tasks already mirrored into
-- Planner stay there; tidy those in Planner by hand if wanted.
--
-- Identity columns are reseeded so RP's first key/inspection/job gets Id 1.
--
-- Blob storage is NOT touched by SQL — run the companion script afterwards:
--   migrations/seeding/handover_clear_keys_inspections_blobs.sh
--
-- ⚠ NOT a migration. This file lives in migrations/seeding/ precisely because
--   runMigrations() only picks up top-level migrations/*.sql — never move it
--   into that folder or it will run automatically on host startup.
--
-- Run by hand with sqlcmd against the target DB, e.g. local Docker:
--
--   docker exec -i azure-functions-sql-1 \
--     /opt/mssql-tools18/bin/sqlcmd \
--     -S localhost -U sa -P "DevPassword123!" -No -I -d command_centre_dev \
--     -i /dev/stdin < migrations/seeding/handover_clear_keys_inspections.sql
--
-- The -I flag (QUOTED_IDENTIFIER ON) is REQUIRED — dbo.Keys carries a filtered
-- index (IX_Keys_Active), and DML on such tables fails without it.
--
-- Everything runs in one transaction — any failure rolls the whole thing back.
-- DBCC CHECKIDENT needs ALTER permission on the tables (db_owner/db_ddladmin).
--
-- Idempotent: re-running against an already-empty DB is a no-op.

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRAN;

-- ── Row counts before, for the run log ───────────────────────────────────────
SELECT 'BEFORE' AS Snapshot, TableName, Total FROM (
  SELECT 'Keys' AS TableName, COUNT(*) AS Total FROM dbo.Keys
  UNION ALL SELECT 'KeyCheckoutBatches',           COUNT(*) FROM dbo.KeyCheckoutBatches
  UNION ALL SELECT 'KeyCheckouts',                 COUNT(*) FROM dbo.KeyCheckouts
  UNION ALL SELECT 'Inspections',                  COUNT(*) FROM dbo.Inspections
  UNION ALL SELECT 'InspectionLevels',             COUNT(*) FROM dbo.InspectionLevels
  UNION ALL SELECT 'InspectionLevelContributors',  COUNT(*) FROM dbo.InspectionLevelContributors
  UNION ALL SELECT 'InspectionRooms',              COUNT(*) FROM dbo.InspectionRooms
  UNION ALL SELECT 'InspectionPoints',             COUNT(*) FROM dbo.InspectionPoints
  UNION ALL SELECT 'InspectionAttachments',        COUNT(*) FROM dbo.InspectionAttachments
  UNION ALL SELECT 'InspectionRaisedJobs',         COUNT(*) FROM dbo.InspectionRaisedJobs
  UNION ALL SELECT 'InspectionMergeSources',       COUNT(*) FROM dbo.InspectionMergeSources
  UNION ALL SELECT 'InspectionOperationLog',       COUNT(*) FROM dbo.InspectionOperationLog
  UNION ALL SELECT 'Jobs',                         COUNT(*) FROM dbo.Jobs
  UNION ALL SELECT 'JobEvents',                    COUNT(*) FROM dbo.JobEvents
  UNION ALL SELECT 'Quotes',                       COUNT(*) FROM dbo.Quotes
  UNION ALL SELECT 'QuoteAttachments',             COUNT(*) FROM dbo.QuoteAttachments
  UNION ALL SELECT 'PurchaseOrders',               COUNT(*) FROM dbo.PurchaseOrders
  UNION ALL SELECT 'PurchaseOrderAttachments',     COUNT(*) FROM dbo.PurchaseOrderAttachments
  UNION ALL SELECT 'Payments',                     COUNT(*) FROM dbo.Payments
  UNION ALL SELECT 'JobInvoices',                  COUNT(*) FROM dbo.JobInvoices
  UNION ALL SELECT 'JobRequestedContractors',      COUNT(*) FROM dbo.JobRequestedContractors
  UNION ALL SELECT 'PlannerTasks (job rows)',      COUNT(*) FROM dbo.PlannerTasks WHERE EntityType = 'job'
  UNION ALL SELECT 'Attachments',                  COUNT(*) FROM dbo.Attachments
  UNION ALL SELECT 'WorkRequests',                 COUNT(*) FROM dbo.WorkRequests
  UNION ALL SELECT 'Invoices',                     COUNT(*) FROM dbo.Invoices
  UNION ALL SELECT 'WorkRequestOverrides',         COUNT(*) FROM dbo.WorkRequestOverrides
  UNION ALL SELECT 'Emails',                       COUNT(*) FROM dbo.Emails
  UNION ALL SELECT 'EmailReplies',                 COUNT(*) FROM dbo.EmailReplies
) t;

-- Blob names of all attachment uploads about to be deleted — the companion
-- _blobs.sh batch-deletes the standard attachments/jobs/* and
-- attachments/workRequests/* prefixes; keep this list from the run log to
-- purge any legacy-shaped names that fall outside those prefixes.
SELECT BlobName AS AttachmentBlob FROM dbo.Attachments;

-- Same for email attachment blobs (JSON array of blob names per email row) —
-- these have no common prefix, so purge them individually if wanted.
SELECT EmailID, AttachmentBlobs AS EmailAttachmentBlobs
  FROM dbo.Emails
 WHERE AttachmentBlobs IS NOT NULL AND AttachmentBlobs <> '[]';

-- ── Inspections domain ───────────────────────────────────────────────────────

-- Break the self-referencing MergedIntoId FK (no cascade) before the bulk delete.
UPDATE dbo.Inspections SET MergedIntoId = NULL WHERE MergedIntoId IS NOT NULL;

DELETE FROM dbo.InspectionRaisedJobs;    -- FK → Inspections has no cascade
DELETE FROM dbo.InspectionMergeSources;  -- FKs → Inspections have no cascade
DELETE FROM dbo.InspectionOperationLog;  -- no FK at all

-- Cascades levels → contributors and rooms → points → attachments.
DELETE FROM dbo.Inspections;

-- ── Jobs domain (incl. the JobEvents activity feed) ──────────────────────────

-- Planner reminder rows for jobs. The mirrored tasks in MS Planner itself are
-- NOT deleted — tidy those in Planner by hand if wanted.
DELETE FROM dbo.PlannerTasks WHERE EntityType = 'job';

-- Payments first: it holds a no-cascade FK to Quotes, so clearing it up front
-- keeps the Jobs cascade from ever touching a still-referenced Quote.
DELETE FROM dbo.Payments;

-- Cascades: JobEvents (activity), Quotes → QuoteAttachments links,
-- PurchaseOrders → PurchaseOrderAttachments links, JobInvoices,
-- JobRequestedContractors (InspectionRaisedJobs already cleared above).
DELETE FROM dbo.Jobs;

-- Attachments (job + WR uploads alike) are cleared wholesale in the
-- work-requests section below.

-- ── Work requests (local myBuildings mirror + app-local state) ───────────────
-- The mirror re-imports CLEAN from myBuildings afterwards — run
-- POST /api/syncAllWorkRequests, or let the timer / per-building screen
-- visits re-pull. Overrides and local uploads are gone for good.

DELETE FROM dbo.WorkRequestOverrides;  -- app-local overlay edits
DELETE FROM dbo.Attachments;           -- all local uploads (job + WR)
DELETE FROM dbo.Invoices;              -- myBuildings mirror, re-syncs with WRs
DELETE FROM dbo.WorkRequests;          -- myBuildings mirror

-- Force every building to re-sync WRs on next access instead of trusting a
-- now-empty "fresh" cache.
UPDATE dbo.Buildings SET WRsLastSyncedAt = NULL WHERE WRsLastSyncedAt IS NOT NULL;

-- ── Incoming domain (email intake queue) ─────────────────────────────────────

DELETE FROM dbo.EmailReplies;   -- FK → Emails has no cascade
DELETE FROM dbo.Emails;

DBCC CHECKIDENT ('dbo.Emails',       RESEED, 0);
DBCC CHECKIDENT ('dbo.EmailReplies', RESEED, 0);

-- WATERMARK — do not delete. graphNotification computes its Graph sync window
-- as MAX(ReceivedAt) FROM Emails and falls back to "beginning" when the table
-- is empty, so without this row the first inbound mail after the clear would
-- re-ingest the ENTIRE mailbox history. Status 'archived' keeps it out of the
-- Incoming queue; AIParsedAt + AIClassification set (with no parse error and
-- no review flag) keep it out of the AI parse claim, the failed-parse reset,
-- and the flagged views. Reseeded above, so it takes EmailID 1.
INSERT INTO dbo.Emails
  (MessageID, Subject, ReceivedAt, Status, ProcessedAt, AIParsedAt, AIClassification)
VALUES
  ('handover-watermark',
   'RP handover watermark — anchors Graph mail sync; delete only after a real email lands',
   SYSUTCDATETIME(), 'archived', SYSUTCDATETIME(), SYSUTCDATETIME(), 'handover-watermark');

-- ── Keys domain ──────────────────────────────────────────────────────────────

DELETE FROM dbo.KeyCheckouts;        -- FKs → Batches and Keys, no cascade
DELETE FROM dbo.KeyCheckoutBatches;
DELETE FROM dbo.Keys;                -- includes soft-deleted (IsDeleted = 1) rows

-- ── Reseed identities so RP's first records start at Id 1 ────────────────────

DBCC CHECKIDENT ('dbo.Inspections',            RESEED, 0);
DBCC CHECKIDENT ('dbo.InspectionRaisedJobs',   RESEED, 0);
DBCC CHECKIDENT ('dbo.Keys',                   RESEED, 0);
DBCC CHECKIDENT ('dbo.KeyCheckoutBatches',     RESEED, 0);
DBCC CHECKIDENT ('dbo.KeyCheckouts',           RESEED, 0);
DBCC CHECKIDENT ('dbo.Jobs',                   RESEED, 0);
DBCC CHECKIDENT ('dbo.JobEvents',              RESEED, 0);
DBCC CHECKIDENT ('dbo.Quotes',                 RESEED, 0);
DBCC CHECKIDENT ('dbo.PurchaseOrders',         RESEED, 0);
DBCC CHECKIDENT ('dbo.Payments',               RESEED, 0);
DBCC CHECKIDENT ('dbo.JobInvoices',            RESEED, 0);
DBCC CHECKIDENT ('dbo.JobRequestedContractors', RESEED, 0);
DBCC CHECKIDENT ('dbo.WorkRequests',           RESEED, 0);
DBCC CHECKIDENT ('dbo.Invoices',               RESEED, 0);
DBCC CHECKIDENT ('dbo.Attachments',            RESEED, 0);

COMMIT;

-- ── Verify: every count below must be 0 ──────────────────────────────────────
SELECT 'AFTER' AS Snapshot, TableName, Total FROM (
  SELECT 'Keys' AS TableName, COUNT(*) AS Total FROM dbo.Keys
  UNION ALL SELECT 'KeyCheckoutBatches',           COUNT(*) FROM dbo.KeyCheckoutBatches
  UNION ALL SELECT 'KeyCheckouts',                 COUNT(*) FROM dbo.KeyCheckouts
  UNION ALL SELECT 'Inspections',                  COUNT(*) FROM dbo.Inspections
  UNION ALL SELECT 'InspectionLevels',             COUNT(*) FROM dbo.InspectionLevels
  UNION ALL SELECT 'InspectionLevelContributors',  COUNT(*) FROM dbo.InspectionLevelContributors
  UNION ALL SELECT 'InspectionRooms',              COUNT(*) FROM dbo.InspectionRooms
  UNION ALL SELECT 'InspectionPoints',             COUNT(*) FROM dbo.InspectionPoints
  UNION ALL SELECT 'InspectionAttachments',        COUNT(*) FROM dbo.InspectionAttachments
  UNION ALL SELECT 'InspectionRaisedJobs',         COUNT(*) FROM dbo.InspectionRaisedJobs
  UNION ALL SELECT 'InspectionMergeSources',       COUNT(*) FROM dbo.InspectionMergeSources
  UNION ALL SELECT 'InspectionOperationLog',       COUNT(*) FROM dbo.InspectionOperationLog
  UNION ALL SELECT 'Jobs',                         COUNT(*) FROM dbo.Jobs
  UNION ALL SELECT 'JobEvents',                    COUNT(*) FROM dbo.JobEvents
  UNION ALL SELECT 'Quotes',                       COUNT(*) FROM dbo.Quotes
  UNION ALL SELECT 'QuoteAttachments',             COUNT(*) FROM dbo.QuoteAttachments
  UNION ALL SELECT 'PurchaseOrders',               COUNT(*) FROM dbo.PurchaseOrders
  UNION ALL SELECT 'PurchaseOrderAttachments',     COUNT(*) FROM dbo.PurchaseOrderAttachments
  UNION ALL SELECT 'Payments',                     COUNT(*) FROM dbo.Payments
  UNION ALL SELECT 'JobInvoices',                  COUNT(*) FROM dbo.JobInvoices
  UNION ALL SELECT 'JobRequestedContractors',      COUNT(*) FROM dbo.JobRequestedContractors
  UNION ALL SELECT 'PlannerTasks (job rows)',      COUNT(*) FROM dbo.PlannerTasks WHERE EntityType = 'job'
  UNION ALL SELECT 'Attachments',                  COUNT(*) FROM dbo.Attachments
  UNION ALL SELECT 'WorkRequests',                 COUNT(*) FROM dbo.WorkRequests
  UNION ALL SELECT 'Invoices',                     COUNT(*) FROM dbo.Invoices
  UNION ALL SELECT 'WorkRequestOverrides',         COUNT(*) FROM dbo.WorkRequestOverrides
  UNION ALL SELECT 'Emails (excl. watermark)',     COUNT(*) FROM dbo.Emails WHERE MessageID <> 'handover-watermark'
  UNION ALL SELECT 'EmailReplies',                 COUNT(*) FROM dbo.EmailReplies
) t;

-- Final checks: WR sync watermarks cleared (so every building re-syncs), and
-- the Graph-sync watermark row present (exactly 1).
SELECT CheckName, Total FROM (
  SELECT 'Buildings.WRsLastSyncedAt still set (must be 0)' AS CheckName, COUNT(*) AS Total
    FROM dbo.Buildings WHERE WRsLastSyncedAt IS NOT NULL
  UNION ALL SELECT 'Watermark row present (must be 1)', COUNT(*)
    FROM dbo.Emails WHERE MessageID = 'handover-watermark'
) c;
