-- 055_drop_rent_basis_and_per_sqm.sql
-- RentBasis and RentPerSqm are no longer used by the frontend or backend API.
-- Re-runnable (idempotent).

-- Drop check constraint (may already be gone if migration was partially run)
IF EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Tenants_RentBasis'
    AND parent_object_id = OBJECT_ID('dbo.Tenants')
)
  ALTER TABLE dbo.Tenants DROP CONSTRAINT CK_Tenants_RentBasis;

-- Drop auto-named default constraint on RentBasis
DECLARE @df NVARCHAR(256);
SELECT @df = name FROM sys.default_constraints
WHERE parent_object_id = OBJECT_ID('dbo.Tenants')
  AND COL_NAME(parent_object_id, parent_column_id) = 'RentBasis';
IF @df IS NOT NULL
  EXEC('ALTER TABLE dbo.Tenants DROP CONSTRAINT [' + @df + ']');

IF COL_LENGTH('dbo.Tenants', 'RentBasis') IS NOT NULL
  ALTER TABLE dbo.Tenants DROP COLUMN RentBasis;

IF COL_LENGTH('dbo.Tenants', 'RentPerSqm') IS NOT NULL
  ALTER TABLE dbo.Tenants DROP COLUMN RentPerSqm;

IF COL_LENGTH('dbo.TenantOccupancyHistory', 'RentPerSqm') IS NOT NULL
  ALTER TABLE dbo.TenantOccupancyHistory DROP COLUMN RentPerSqm;
