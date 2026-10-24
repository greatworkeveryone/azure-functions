-- Migration 159: tenancy_lease_type (Tenancy Schedule report, TS3 / decision T11).
--
-- The Tenancy Schedule labels each lease's rent line by what kind of lease it
-- is ("Retail rent", "Office rent", "Licence fee", ...), and its summary groups
-- charges by category. The lease type is a label on the tenancy, so it needs
-- one column on dbo.Tenants:
--
--   LeaseType  NULL, or one of: retail, office, licence, casualMallLicence,
--              carParkOnly, other. A CHECK constraint keeps it to those six.
--
-- There is no backfill: every existing tenancy reads as "no lease type yet",
-- and the report's Data gaps panel counts them until someone sets one. It
-- changes no figure and no schedule term, so nothing is ledgered and no
-- ScheduleVersion moves. The list is kept in step with src/chargeCategories.ts
-- here and src/constants/chargeCategories.ts on the frontend ("change both").
--
-- Charge categories live inside the MiscFees JSON and need no migration.
--
-- Additive and re-runnable: each ALTER sits behind a COL_LENGTH / OBJECT_ID
-- check in its own GO batch (the CHECK must compile after the column exists).
-- Nothing is dropped, narrowed or rewritten.
--
-- RUNBOOK: apply 159 before the build that reads Tenants.LeaseType, or the
-- register and the Tenancy Schedule fail on an unknown column name. Dry-run it
-- on a restored copy of production first (database-safety rules, section 4).

IF COL_LENGTH('dbo.Tenants', 'LeaseType') IS NULL
  ALTER TABLE dbo.Tenants ADD LeaseType NVARCHAR(30) NULL;
GO

IF OBJECT_ID('dbo.CK_Tenants_LeaseType', 'C') IS NULL
  ALTER TABLE dbo.Tenants ADD CONSTRAINT CK_Tenants_LeaseType
    CHECK (LeaseType IS NULL OR LeaseType IN (N'retail', N'office', N'licence', N'casualMallLicence', N'carParkOnly', N'other'));
GO
