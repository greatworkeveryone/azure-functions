-- DESTRUCTIVE: rename building -3 "13 Seale St, Fannie Bay" to "13 Seale St" (name only; address unchanged; reversible) · approved by Will McDonald 2026-11-20
-- Drop the suburb from the Seale St residence's display name: it was the only
-- building named with one. Requested by Will 2026-11-16.
-- BuildingAddress keeps "13 Seale St, Fannie Bay". Reverse by setting the name back.
-- Match ID AND name so a reused manual ID cannot rename another property.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

UPDATE dbo.Buildings
SET BuildingName = N'13 Seale St', UpdatedAt = SYSUTCDATETIME()
WHERE BuildingID = -3
  AND BuildingName = N'13 Seale St, Fannie Bay'
  AND NOT EXISTS (SELECT 1 FROM dbo.Buildings WHERE BuildingName = N'13 Seale St');

COMMIT TRANSACTION;
