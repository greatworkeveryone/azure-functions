-- Migration 016: Tenants.BuildingID → Buildings.BuildingID foreign key.
--
-- Migration 015 intentionally left this off because the original FK
-- declaration failed with "no primary or candidate keys match the
-- referencing column list" — SQL Server needs a named UNIQUE (or PK)
-- on the referenced column, and the inline `BuildingID INT NOT NULL
-- UNIQUE` in migration 001 produced a system-generated constraint
-- name that the FK couldn't latch onto reliably.
--
-- This migration:
--   1. Adds a named UNIQUE constraint `UK_Buildings_BuildingID` on
--      dbo.Buildings(BuildingID). SQL Server allows multiple UNIQUE
--      constraints on the same column, so this lays cleanly on top of
--      the existing auto-named one without disrupting it.
--   2. Adds the FK `FK_Tenants_Buildings` now that there's a stable
--      named candidate key to reference.
--
-- Fully idempotent — both steps guard on sys catalog views.

IF NOT EXISTS (
  SELECT 1 FROM sys.key_constraints
   WHERE parent_object_id = OBJECT_ID('dbo.Buildings')
     AND name = 'UK_Buildings_BuildingID'
)
  ALTER TABLE dbo.Buildings
    ADD CONSTRAINT UK_Buildings_BuildingID UNIQUE (BuildingID);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
   WHERE parent_object_id = OBJECT_ID('dbo.Tenants')
     AND name = 'FK_Tenants_Buildings'
)
  ALTER TABLE dbo.Tenants
    ADD CONSTRAINT FK_Tenants_Buildings FOREIGN KEY (BuildingID)
      REFERENCES dbo.Buildings(BuildingID);
GO
