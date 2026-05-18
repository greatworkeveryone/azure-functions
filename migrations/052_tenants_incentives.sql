-- 052_tenants_incentives.sql
--
-- Adds a JSON-column-with-CHECK pair to dbo.Tenants for storing lease
-- incentives (rent-free months, monthly reductions). We store the whole
-- array as JSON in NVARCHAR(MAX) rather than break it into a child table:
--   • The dataset is always small (<10 per tenant)
--   • It's always read together with the tenant row
--   • The frontend treats the array as a single field
-- A child table would just multiply joins for no analytical upside.
--
-- The CHECK constraint uses ISJSON() so SQL Server enforces well-formed
-- JSON at insert/update time — the parser inside ISJSON is the same one
-- OPENJSON uses, so we get cheap validation without paying for a trigger.
--
-- Apply manually with sqlcmd / Azure Data Studio, OR via the in-process
-- migrate runner (src/migrate.ts) which scans this directory on startup.
-- Re-runnable (idempotent column add + idempotent constraint add).

IF COL_LENGTH('dbo.Tenants', 'Incentives') IS NULL
  ALTER TABLE dbo.Tenants ADD Incentives NVARCHAR(MAX) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Tenants_Incentives_IsJson'
    AND parent_object_id = OBJECT_ID('dbo.Tenants')
)
  ALTER TABLE dbo.Tenants
    ADD CONSTRAINT CK_Tenants_Incentives_IsJson
      CHECK (Incentives IS NULL OR ISJSON(Incentives) = 1);
GO
