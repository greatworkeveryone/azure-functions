-- 140_archive_occupancy_carpark — areas and car parks are archived, never deleted (D10).
--
-- deleteOccupancy and deleteCarpark hard-deleted a tenancy's areas and bays
-- (J4 review). They are replaced by archiveOccupancy / archiveCarpark and their
-- restores: each stamps who, when and why, ledgers it with the reason, and can
-- be undone. Archived rows leave the register, the summary, the portfolio
-- figures and the planner (every read carries ArchivedAt IS NULL; guarded by
-- src/__tests__/archived-parts-guards.test.ts).
--
-- Additive and re-runnable: three nullable columns per table, each behind a
-- column-exists guard. Nothing is backfilled, rewritten or deleted.

IF COL_LENGTH(N'dbo.TenantOccupancies', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.TenantOccupancies ADD ArchivedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.TenantOccupancies', N'ArchivedBy') IS NULL
  ALTER TABLE dbo.TenantOccupancies ADD ArchivedBy NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.TenantOccupancies', N'ArchiveReason') IS NULL
  ALTER TABLE dbo.TenantOccupancies ADD ArchiveReason NVARCHAR(2000) NULL;
GO

IF COL_LENGTH(N'dbo.Carparks', N'ArchivedAt') IS NULL
  ALTER TABLE dbo.Carparks ADD ArchivedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.Carparks', N'ArchivedBy') IS NULL
  ALTER TABLE dbo.Carparks ADD ArchivedBy NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.Carparks', N'ArchiveReason') IS NULL
  ALTER TABLE dbo.Carparks ADD ArchiveReason NVARCHAR(2000) NULL;
