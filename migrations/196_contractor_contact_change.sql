-- SECA-04: when a contractor's email or ABN was last changed, by whom, and whether a second person has
-- confirmed it. A purchase order to that contractor shows the change and needs the sender's tick until a
-- second person confirms or two business days pass. Additive and idempotent: four nullable columns.
IF COL_LENGTH(N'dbo.Contractors', N'ContactChangedAt') IS NULL
  ALTER TABLE dbo.Contractors ADD ContactChangedAt DATETIME2(0) NULL;
GO

IF COL_LENGTH(N'dbo.Contractors', N'ContactChangedBy') IS NULL
  ALTER TABLE dbo.Contractors ADD ContactChangedBy NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.Contractors', N'ContactConfirmedAt') IS NULL
  ALTER TABLE dbo.Contractors ADD ContactConfirmedAt DATETIME2(0) NULL;
GO

IF COL_LENGTH(N'dbo.Contractors', N'ContactConfirmedBy') IS NULL
  ALTER TABLE dbo.Contractors ADD ContactConfirmedBy NVARCHAR(255) NULL;
GO
