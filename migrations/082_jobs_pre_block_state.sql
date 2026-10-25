-- Migration 082: Capture the pre-block composite state on Jobs.
-- When a job is tenant-blocked we now remember exactly where it was —
-- (Status, AwaitingRole) — so unblocking restores that state instead of
-- always landing in (Work, facilities). Without this a job blocked at
-- (Awaiting Approval, facilities) — quote not yet approved — would arrive in
-- Work on unblock, skipping QUOTE_APPROVED and the manager approval limit.
--
-- Dedicated NULLABLE columns (not event-log replay): addJobEvent stores
-- NewStatus / NewAwaitingRole on separate event rows on some paths, so a
-- replay can't reliably reconstruct the immediately-pre-block composite. These
-- two columns are written in the SAME transaction as the TENANT_BLOCKED status
-- write and cleared in the SAME transaction as TENANT_UNBLOCKED, so they only
-- ever hold a value while the job is parked in Tenant.
--
-- Both NULL by default: existing Tenant-blocked rows (blocked before this
-- migration) have no captured state and fall back to the legacy (Work,
-- facilities) landing on unblock — the machine's UNBLOCK_FALLBACK.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'PreBlockStatus'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD PreBlockStatus NVARCHAR(50) NULL;
  PRINT 'Added PreBlockStatus column to dbo.Jobs';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'PreBlockAwaitingRole'
)
BEGIN
  ALTER TABLE dbo.Jobs ADD PreBlockAwaitingRole NVARCHAR(20) NULL;
  PRINT 'Added PreBlockAwaitingRole column to dbo.Jobs';
END;
GO
