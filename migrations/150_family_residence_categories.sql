-- DESTRUCTIVE: classify the three family residences as requested in chat · approved by Connor Randazzo 2026-10-18
-- Classify the three family residences seeded by 093, as requested by Connor.
-- The 136 migration deliberately left these as commercial pending this decision.
-- Match IDs AND names so a reused manual ID cannot reclassify another property.
-- Owner names and all other metadata are preserved. No records are removed.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID('dbo.BuildingCategories_bak_20261018', 'U') IS NULL
  SELECT BuildingID, BuildingName, Category, OwnerName, SYSUTCDATETIME() AS BackedUpAt
    INTO dbo.BuildingCategories_bak_20261018
    FROM dbo.Buildings WHERE BuildingID IN (-1,-2,-3);

UPDATE dbo.Buildings SET Category = N'residence', UpdatedAt = SYSUTCDATETIME()
WHERE Category <> N'residence' AND (
  (BuildingID = -1 AND BuildingName = N'25 Temira Crescent') OR
  (BuildingID = -2 AND BuildingName = N'23 Temira Crescent') OR
  (BuildingID = -3 AND BuildingName = N'13 Seale St, Fannie Bay')
);

COMMIT TRANSACTION;
