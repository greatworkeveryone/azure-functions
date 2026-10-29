-- Migration 093: Manual buildings not managed in myBuildings.
--
-- Negative BuildingIDs can't collide with myBuildings' positive IDs, so
-- syncBuildings never touches these rows. workRequests skips the myBuildings
-- WR fetch for BuildingID <= 0 (there is nothing upstream to pull).
-- If one of these is later added to myBuildings, sync will insert a second row
-- under the real ID — repoint FKs and delete the manual row at that point.
-- Re-runnable: MERGE, not INSERT.

MERGE dbo.Buildings AS target
USING (VALUES
  (-1, N'25 Temira Crescent',      N'25 Temira Crescent'),
  (-2, N'23 Temira Crescent',      N'23 Temira Crescent'),
  (-3, N'13 Seale St, Fannie Bay', N'13 Seale St, Fannie Bay')
) AS source (BuildingID, BuildingName, BuildingAddress)
ON target.BuildingID = source.BuildingID
WHEN NOT MATCHED THEN
  INSERT (BuildingID, BuildingName, BuildingAddress, Active, CreatedAt, UpdatedAt)
  VALUES (source.BuildingID, source.BuildingName, source.BuildingAddress, 1, GETUTCDATE(), GETUTCDATE());
GO
