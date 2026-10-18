-- 141_tenant_notes_archive_infosheet_versions — tenancy notes are archived,
-- never deleted; the info sheet carries a version (D11).
--
-- deleteTenantNote hard-deleted a note, including the change notes written
-- when a lease field is edited, with no ledger row. It is replaced by
-- archiveTenantNote / unarchiveTenantNote: each stamps who, when and why,
-- ledgers it with the reason, and can be undone. Archived notes leave the
-- tenancy's notes and the register's note counts (every read carries
-- ArchivedAt IS NULL; guarded by src/__tests__/archived-parts-guards.test.ts).
--
-- deleteInfoSheetSection and deleteInfoSheetRow rewrote Tenants.InfoSheetSections
-- with no version. InfoSheetVersion goes up on every info sheet write; a delete
-- names the version it was shown and is refused (409) when it has moved on.
--
-- Additive and re-runnable: three nullable columns and one column with a
-- default, each behind a column-exists guard. Nothing is backfilled, rewritten
-- or deleted.

IF COL_LENGTH(N'dbo.TenantNotes', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.TenantNotes ADD ArchivedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.TenantNotes', N'ArchivedBy') IS NULL
  ALTER TABLE dbo.TenantNotes ADD ArchivedBy NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.TenantNotes', N'ArchiveReason') IS NULL
  ALTER TABLE dbo.TenantNotes ADD ArchiveReason NVARCHAR(2000) NULL;
GO

IF COL_LENGTH(N'dbo.Tenants', N'InfoSheetVersion') IS NULL
  ALTER TABLE dbo.Tenants ADD InfoSheetVersion INT NOT NULL CONSTRAINT DF_Tenants_InfoSheetVersion DEFAULT 0;
GO
