-- Migration 069: Add InfoSheetSections JSON column to Tenants.
-- Stores an array of { id, title, displayOrder, rows: [{ id, subheader, body, displayOrder }] }
-- following the same JSON-in-column pattern as MiscFees, Incentives, etc.

ALTER TABLE dbo.Tenants
  ADD InfoSheetSections NVARCHAR(MAX) NULL;
GO

ALTER TABLE dbo.Tenants
  ADD CONSTRAINT CK_Tenants_InfoSheetSections
    CHECK (InfoSheetSections IS NULL OR ISJSON(InfoSheetSections) = 1);
GO
