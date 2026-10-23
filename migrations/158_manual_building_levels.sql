-- DESTRUCTIVE: fill Levels for the three manual buildings (-1, -2, -3) where it is still NULL; no row or existing value is removed · approved by Will McDonald 2026-10-23
-- 158_manual_building_levels — levels for the three manual buildings from 093.
--
-- 093_manual_buildings.sql inserted the manual (negative-ID) buildings without
-- Levels, so they sit at NULL in production and the staging copy. A 14 Oct edit
-- added the levels to 093's MERGE, but the runner never re-runs an applied
-- file, so 093 is restored to the version that was applied and the backfill
-- lands here instead. Fix-forward for the checksum drift found on the first
-- staging deploy, 23 Oct.
--
-- Re-runnable and conservative: only rows still at NULL are touched, so a
-- value set by hand in the meantime is kept.

UPDATE b
SET b.Levels = v.Levels, b.UpdatedAt = GETUTCDATE()
FROM dbo.Buildings AS b
JOIN (VALUES
  (-1, N'["Ground Floor","Level 1"]'),
  (-2, N'["Ground Floor","Level 1","Level 2"]'),
  (-3, N'["Lower Ground","Ground Floor"]')
) AS v (BuildingID, Levels) ON v.BuildingID = b.BuildingID
WHERE b.Levels IS NULL;
GO
