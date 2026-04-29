-- 040_tenancy_info_sheet_fields.sql
--
-- Adds the four fields the per-tenant Information Sheet panel needs that
-- weren't already on dbo.Tenants:
--
--   • Lot                       — title/lot reference, e.g. "5443".
--   • StreetAddress             — physical address (separate from the existing
--                                 PostalAddress, which holds GPO/PO Box style
--                                 mail addresses).
--   • InformationSheetAsAt      — date the snapshot was taken. NVARCHAR per
--                                 the m039 lesson (source values are free-form
--                                 like "5/1/19", not strict ISO dates).
--   • InformationSheetReference — file path or doc id, e.g.
--                                 "Leasing\2019\Form 34 - Lease Agreement_190501.pdf".
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'Lot'
)
  ALTER TABLE dbo.Tenants ADD Lot NVARCHAR(100) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'StreetAddress'
)
  ALTER TABLE dbo.Tenants ADD StreetAddress NVARCHAR(500) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'InformationSheetAsAt'
)
  ALTER TABLE dbo.Tenants ADD InformationSheetAsAt NVARCHAR(50) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'InformationSheetReference'
)
  ALTER TABLE dbo.Tenants ADD InformationSheetReference NVARCHAR(500) NULL;
GO
