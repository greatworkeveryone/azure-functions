-- m058: add holdover_terms to tenants
-- Free-form text describing what happens if the lease expires before a new one is negotiated.

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'HoldoverTerms')
  ALTER TABLE dbo.Tenants ADD HoldoverTerms NVARCHAR(MAX) NULL;
GO
