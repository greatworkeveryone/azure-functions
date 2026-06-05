-- Migration 081: Perf indexes from the 2026-05-30 DB audit.
-- All four indexes are additive and guarded with IF NOT EXISTS so re-running
-- the migration is a no-op. Drops are reversible:
--   DROP INDEX IX_Jobs_Archived_Status_Building ON dbo.Jobs;
--   DROP INDEX IX_Invoices_InvoiceDate          ON dbo.Invoices;
--   DROP INDEX IX_Quotes_CreatedAt              ON dbo.Quotes;
--   DROP INDEX IX_Jobs_ExpectedProgressUpdate   ON dbo.Jobs;

-- ── IX_Jobs_Archived_Status_Building ─────────────────────────────────────────
-- Covers getJobs' dominant filter combo: WHERE IsArchived=? AND Status=? AND
-- BuildingID=?  ORDER BY LastModifiedDate DESC.  Single-column indexes on
-- BuildingID and Status exist already; this composite lets the planner seek
-- on all three predicates without combining indexes, and INCLUDE puts
-- LastModifiedDate in the leaf so the ORDER BY uses the index directly.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Jobs_Archived_Status_Building'
    AND object_id = OBJECT_ID('dbo.Jobs')
)
BEGIN
  CREATE INDEX IX_Jobs_Archived_Status_Building
    ON dbo.Jobs (IsArchived, Status, BuildingID)
    INCLUDE (LastModifiedDate);
  PRINT 'Created IX_Jobs_Archived_Status_Building';
END;
GO

-- ── IX_Invoices_InvoiceDate ──────────────────────────────────────────────────
-- Covers getInvoices' ORDER BY InvoiceDate DESC.  Currently no index on
-- InvoiceDate, so the planner does a full sort after the filter.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Invoices_InvoiceDate'
    AND object_id = OBJECT_ID('dbo.Invoices')
)
BEGIN
  CREATE INDEX IX_Invoices_InvoiceDate
    ON dbo.Invoices (InvoiceDate DESC);
  PRINT 'Created IX_Invoices_InvoiceDate';
END;
GO

-- ── IX_Quotes_CreatedAt ──────────────────────────────────────────────────────
-- Covers getQuotes' ORDER BY CreatedAt DESC.  Migration 008 indexed JobID +
-- Status; CreatedAt is unindexed, so the ORDER BY currently forces a sort.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Quotes_CreatedAt'
    AND object_id = OBJECT_ID('dbo.Quotes')
)
BEGIN
  CREATE INDEX IX_Quotes_CreatedAt
    ON dbo.Quotes (CreatedAt DESC);
  PRINT 'Created IX_Quotes_CreatedAt';
END;
GO

-- ── IX_Jobs_ExpectedProgressUpdate ───────────────────────────────────────────
-- Filtered to non-archived rows because plannerSyncTimer only scans active
-- jobs.  The current query at plannerSyncTimer.ts:329 wraps the column in
-- CAST(... AS DATE), which prevents any index seek; Task 3 of this plan
-- rewrites that query to sargable form so this index can be used.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Jobs_ExpectedProgressUpdate'
    AND object_id = OBJECT_ID('dbo.Jobs')
)
BEGIN
  CREATE INDEX IX_Jobs_ExpectedProgressUpdate
    ON dbo.Jobs (ExpectedProgressUpdate)
    WHERE IsArchived = 0;
  PRINT 'Created IX_Jobs_ExpectedProgressUpdate';
END;
GO
