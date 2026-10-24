-- Migration 160: tenancy_gst_basis (Tenancy Schedule report and register, decision T14).
--
-- Rents and fees on a tenancy are entered either ex GST or inc GST, and staff
-- choose which when they add or edit the tenancy. Floorplan never converts a
-- figure between the two, so the basis is a label on the tenancy and every
-- money figure for it is shown with that label. One column on dbo.Tenants:
--
--   GstBasis  NULL, or one of: ex, inc. A CHECK constraint keeps it to those
--             two. NULL means "not recorded".
--
-- There is no backfill: every existing tenancy reads as "GST basis not
-- recorded", and the Tenancy Schedule's Data gaps panel lists them until
-- someone chooses. It changes no figure and no schedule term, so nothing is
-- ledgered and no ScheduleVersion moves. The list is kept in step with
-- src/gstBasis.ts here and src/constants/gstBasis.ts on the frontend ("change
-- both").
--
-- Additive and re-runnable: each ALTER sits behind a COL_LENGTH / OBJECT_ID
-- check in its own GO batch (the CHECK must compile after the column exists).
-- Nothing is dropped, narrowed or rewritten.
--
-- RUNBOOK: apply 160 before the build that reads Tenants.GstBasis, or the
-- register and the Tenancy Schedule fail on an unknown column name. Dry-run it
-- on a restored copy of production first (database-safety rules, section 4).

IF COL_LENGTH('dbo.Tenants', 'GstBasis') IS NULL
  ALTER TABLE dbo.Tenants ADD GstBasis NVARCHAR(3) NULL;
GO

IF OBJECT_ID('dbo.CK_Tenants_GstBasis', 'C') IS NULL
  ALTER TABLE dbo.Tenants ADD CONSTRAINT CK_Tenants_GstBasis
    CHECK (GstBasis IS NULL OR GstBasis IN (N'ex', N'inc'));
GO
