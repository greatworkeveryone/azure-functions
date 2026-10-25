-- Migration 136: building_category_owner (beta sprint U8, Residences).
--
-- The building gallery gets a second level: commercial buildings on the main
-- grid, residences behind one "Residences" tile, each residence showing its
-- owner. This adds the two columns that drive it to dbo.Buildings:
--
--   Category   'commercial' (default) or 'residence'. NOT NULL with a default,
--              so every existing row reads as commercial with no backfill.
--              A CHECK constraint keeps it to those two values.
--   OwnerName  who owns the residence, free text up to 200 characters. NULL
--              for commercial buildings and for residences with no owner yet.
--
-- No row is rewritten: the three manual buildings from migration 093 (23 and
-- 25 Temira Crescent, 13 Seale St) stay 'commercial' until an admin sets
-- their category and owner on the manual-buildings screen.
--
-- Additive and re-runnable: each ALTER sits behind a COL_LENGTH / OBJECT_ID
-- check in its own GO batch (the CHECK must compile after the column exists).
-- Nothing is dropped, narrowed or updated.
--
-- RUNBOOK: apply 136 before the build that serves getBuildings with these
-- columns, or the building list fails on an unknown column name.

IF COL_LENGTH('dbo.Buildings', 'Category') IS NULL
  ALTER TABLE dbo.Buildings ADD Category NVARCHAR(20) NOT NULL
    CONSTRAINT DF_Buildings_Category DEFAULT N'commercial';
GO

IF COL_LENGTH('dbo.Buildings', 'OwnerName') IS NULL
  ALTER TABLE dbo.Buildings ADD OwnerName NVARCHAR(200) NULL;
GO

IF OBJECT_ID('dbo.CK_Buildings_Category', 'C') IS NULL
  ALTER TABLE dbo.Buildings ADD CONSTRAINT CK_Buildings_Category
    CHECK (Category IN (N'commercial', N'residence'));
GO
