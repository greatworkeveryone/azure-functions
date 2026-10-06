-- Migration 086: Seed inspections for demos / walk-throughs.
--
-- Creates 6 inspections against random active Buildings so the Inspections
-- screens have realistic data to show off end to end:
--
--   3 drafts at increasing stages of a walk-through
--     - "just started"  — 1 level, 2 rooms, one logged point + trailing blanks
--     - "in progress"   — 2 levels, real points plus a blank trailing point
--     - "nearly done"   — 2 levels, 4 rooms, all real points, ready to complete
--   3 complete inspections, fully filled (CompletedAt/By set, staggered dates)
--
-- Blank points (Description = '') appear only in the drafts — they mirror the
-- placeholder point a room seeds mid-walk and get filtered out of read/export
-- surfaces. The complete inspections carry only real points so they export clean.
--
-- Attribution: CreatedByName / AddedByName carry realistic inspector names so
-- the UI reads naturally, while every row is tagged CreatedById/AddedById =
-- 'seed:086' for a stable, cleanup-friendly marker.
--
-- Seed file — the migration runner skips anything with "_seed_" in the name,
-- so run this by hand against a local Docker DB:
--
--   docker exec -it azure-functions-sql-1 \
--     /opt/mssql-tools18/bin/sqlcmd \
--     -S localhost -U sa -P "DevPassword123!" -No -d command_centre_dev \
--     -i migrations/086_seed_inspections.sql
--
-- Idempotent: guarded on the seed tag. To reseed, delete then re-run — levels,
-- rooms, points and contributors all cascade from Inspections:
--
--   DELETE FROM dbo.Inspections WHERE CreatedById = 'seed:086';

IF NOT EXISTS (SELECT 1 FROM dbo.Inspections WHERE CreatedById = 'seed:086')
BEGIN
  DECLARE @iid INT;
  DECLARE @now DATETIME2 = SYSUTCDATETIME();

  -- ── Inspection 1 — DRAFT, just started ─────────────────────────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'Routine walk-through — ground floor', 'draft',
     'seed:086', 'Sarah Chen', DATEADD(DAY, -2, @now), DATEADD(DAY, -2, @now));
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i1-l1', @iid, 'Ground Floor', 0);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i1-l1', 'seed:086', 'Sarah Chen');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i1-l1-r1', 'seed086-i1-l1', 'Lobby',     0, 'seed:086', 'Sarah Chen'),
    ('seed086-i1-l1-r2', 'seed086-i1-l1', 'Reception', 1, 'seed:086', 'Sarah Chen');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i1-l1-r1-p1', 'seed086-i1-l1-r1', 'Scuff marks on wall near lift call button.', 0, 'seed:086', 'Sarah Chen'),
    ('seed086-i1-l1-r1-p2', 'seed086-i1-l1-r1', '',                                            1, 'seed:086', 'Sarah Chen'),
    ('seed086-i1-l1-r2-p1', 'seed086-i1-l1-r2', '',                                            0, 'seed:086', 'Sarah Chen');

  -- ── Inspection 2 — DRAFT, in progress ──────────────────────────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'Quarterly inspection — in progress', 'draft',
     'seed:086', 'Mike Doyle', DATEADD(DAY, -4, @now), DATEADD(DAY, -1, @now));
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i2-l1', @iid, 'Ground Floor', 0),
    ('seed086-i2-l2', @iid, 'Level 1',      1);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i2-l1', 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l2', 'seed:086', 'Mike Doyle');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i2-l1-r1', 'seed086-i2-l1', 'Main Entrance', 0, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l1-r2', 'seed086-i2-l1', 'Kitchenette',   1, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l2-r1', 'seed086-i2-l2', 'Meeting Room A',0, 'seed:086', 'Mike Doyle');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i2-l1-r1-p1', 'seed086-i2-l1-r1', 'Entry mat frayed at edge, trip hazard.',      0, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l1-r1-p2', 'seed086-i2-l1-r1', 'Automatic door sensor slow to trigger.',      1, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l1-r2-p1', 'seed086-i2-l1-r2', 'Tap dripping at hot water side.',             0, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l2-r1-p1', 'seed086-i2-l2-r1', 'Projector mount loose.',                      0, 'seed:086', 'Mike Doyle'),
    ('seed086-i2-l2-r1-p2', 'seed086-i2-l2-r1', '',                                            1, 'seed:086', 'Mike Doyle');

  -- ── Inspection 3 — DRAFT, nearly done (ready to complete) ───────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'Pre-winter building check', 'draft',
     'seed:086', 'Priya Nair', DATEADD(DAY, -6, @now), DATEADD(HOUR, -6, @now));
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i3-l1', @iid, 'Ground Floor', 0),
    ('seed086-i3-l2', @iid, 'Basement',     1);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i3-l1', 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2', 'seed:086', 'Priya Nair');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i3-l1-r1', 'seed086-i3-l1', 'Lobby',      0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l1-r2', 'seed086-i3-l1', 'Toilets',    1, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r1', 'seed086-i3-l2', 'Plant Room', 0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r2', 'seed086-i3-l2', 'Car Park',   1, 'seed:086', 'Priya Nair');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i3-l1-r1-p1', 'seed086-i3-l1-r1', 'Ceiling tile stained near skylight, monitor for leak.', 0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l1-r1-p2', 'seed086-i3-l1-r1', 'Skirting board scuffed along east wall.',                1, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l1-r2-p1', 'seed086-i3-l1-r2', 'Cubicle lock sticking in accessible WC.',                0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l1-r2-p2', 'seed086-i3-l1-r2', 'Extractor fan noisy.',                                   1, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r1-p1', 'seed086-i3-l2-r1', 'Pump 2 showing minor corrosion at base.',                0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r1-p2', 'seed086-i3-l2-r1', 'Lagging on hot pipe run coming loose.',                  1, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r2-p1', 'seed086-i3-l2-r2', 'Line marking faded in bays 12 to 18.',                   0, 'seed:086', 'Priya Nair'),
    ('seed086-i3-l2-r2-p2', 'seed086-i3-l2-r2', 'One overhead light out near exit ramp.',                 1, 'seed:086', 'Priya Nair');

  -- ── Inspection 4 — COMPLETE, monthly ───────────────────────────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt,
     CompletedAt, CompletedById, CompletedByName)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'Monthly inspection', 'complete',
     'seed:086', 'Tom Bennett', DATEADD(DAY, -7, @now), DATEADD(DAY, -5, @now),
     DATEADD(DAY, -5, @now), 'seed:086', 'Tom Bennett');
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i4-l1', @iid, 'Ground Floor', 0),
    ('seed086-i4-l2', @iid, 'Level 1',      1);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i4-l1', 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2', 'seed:086', 'Tom Bennett');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i4-l1-r1', 'seed086-i4-l1', 'Lobby',       0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l1-r2', 'seed086-i4-l1', 'Reception',   1, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r1', 'seed086-i4-l2', 'Open Office', 0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r2', 'seed086-i4-l2', 'Kitchenette', 1, 'seed:086', 'Tom Bennett');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i4-l1-r1-p1', 'seed086-i4-l1-r1', 'Floor tiles in good condition.',            0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l1-r1-p2', 'seed086-i4-l1-r1', 'Directory board up to date.',               1, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l1-r2-p1', 'seed086-i4-l1-r2', 'Reception desk laminate chipped at corner.',0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l1-r2-p2', 'seed086-i4-l1-r2', 'Visitor seating clean and intact.',         1, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r1-p1', 'seed086-i4-l2-r1', 'Two ceiling downlights flickering.',        0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r1-p2', 'seed086-i4-l2-r1', 'Carpet lifting near window bay.',           1, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r2-p1', 'seed086-i4-l2-r2', 'Fridge seal perished.',                     0, 'seed:086', 'Tom Bennett'),
    ('seed086-i4-l2-r2-p2', 'seed086-i4-l2-r2', 'Bin area needs deep clean.',                1, 'seed:086', 'Tom Bennett');

  -- ── Inspection 5 — COMPLETE, fire & safety ─────────────────────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt,
     CompletedAt, CompletedById, CompletedByName)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'Fire & safety walk-through', 'complete',
     'seed:086', 'Laura Simmons', DATEADD(DAY, -14, @now), DATEADD(DAY, -12, @now),
     DATEADD(DAY, -12, @now), 'seed:086', 'Laura Simmons');
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i5-l1', @iid, 'Basement',     0),
    ('seed086-i5-l2', @iid, 'Ground Floor', 1),
    ('seed086-i5-l3', @iid, 'Level 1',      2);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i5-l1', 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2', 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l3', 'seed:086', 'Laura Simmons');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i5-l1-r1', 'seed086-i5-l1', 'Plant Room',    0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l1-r2', 'seed086-i5-l1', 'Store Room',    1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r1', 'seed086-i5-l2', 'Main Entrance', 0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r2', 'seed086-i5-l2', 'Stairwell',     1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l3-r1', 'seed086-i5-l3', 'Corridor',      0, 'seed:086', 'Laura Simmons');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i5-l1-r1-p1', 'seed086-i5-l1-r1', 'Fire extinguisher tag expired, replacement due.',            0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l1-r1-p2', 'seed086-i5-l1-r1', 'Emergency light test due this month.',                       1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l1-r2-p1', 'seed086-i5-l1-r2', 'Combustible materials stored too close to switchboard.',     0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l1-r2-p2', 'seed086-i5-l1-r2', 'Floor clear, access good.',                                  1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r1-p1', 'seed086-i5-l2-r1', 'Fire door does not close fully, hinge adjustment needed.',   0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r1-p2', 'seed086-i5-l2-r1', 'Exit signage illuminated and clear.',                        1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r2-p1', 'seed086-i5-l2-r2', 'Handrail secure.',                                           0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l2-r2-p2', 'seed086-i5-l2-r2', 'Non-slip nosing worn on lower flight.',                      1, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l3-r1-p1', 'seed086-i5-l3-r1', 'Smoke detector due for service.',                            0, 'seed:086', 'Laura Simmons'),
    ('seed086-i5-l3-r1-p2', 'seed086-i5-l3-r1', 'Fire hose reel gauge in green.',                             1, 'seed:086', 'Laura Simmons');

  -- ── Inspection 6 — COMPLETE, end of tenancy ────────────────────────────────
  INSERT INTO dbo.Inspections
    (BuildingId, Title, Status, CreatedById, CreatedByName, CreatedAt, LastModifiedAt,
     CompletedAt, CompletedById, CompletedByName)
  VALUES
    ((SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID()),
     'End of tenancy inspection', 'complete',
     'seed:086', 'James Okafor', DATEADD(DAY, -22, @now), DATEADD(DAY, -20, @now),
     DATEADD(DAY, -20, @now), 'seed:086', 'James Okafor');
  SET @iid = SCOPE_IDENTITY();

  INSERT INTO dbo.InspectionLevels (Id, InspectionId, Name, SortOrder) VALUES
    ('seed086-i6-l1', @iid, 'Ground Floor', 0),
    ('seed086-i6-l2', @iid, 'Level 1',      1);

  INSERT INTO dbo.InspectionLevelContributors (LevelId, UserId, UserName) VALUES
    ('seed086-i6-l1', 'seed:086', 'James Okafor'),
    ('seed086-i6-l2', 'seed:086', 'James Okafor');

  INSERT INTO dbo.InspectionRooms (Id, LevelId, Name, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i6-l1-r1', 'seed086-i6-l1', 'Living Area', 0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l1-r2', 'seed086-i6-l1', 'Kitchen',     1, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r1', 'seed086-i6-l2', 'Bedroom',     0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r2', 'seed086-i6-l2', 'Bathroom',    1, 'seed:086', 'James Okafor');

  INSERT INTO dbo.InspectionPoints (Id, RoomId, Description, SortOrder, AddedById, AddedByName) VALUES
    ('seed086-i6-l1-r1-p1', 'seed086-i6-l1-r1', 'Walls marked, repaint required before re-let.', 0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l1-r1-p2', 'seed086-i6-l1-r1', 'Window latch stiff.',                           1, 'seed:086', 'James Okafor'),
    ('seed086-i6-l1-r2-p1', 'seed086-i6-l1-r2', 'Oven interior heavily soiled.',                 0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l1-r2-p2', 'seed086-i6-l1-r2', 'Splashback tile cracked above hob.',            1, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r1-p1', 'seed086-i6-l2-r1', 'Carpet stained near wardrobe.',                 0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r1-p2', 'seed086-i6-l2-r1', 'Blind cord frayed.',                            1, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r2-p1', 'seed086-i6-l2-r2', 'Silicone sealant mouldy around bath.',          0, 'seed:086', 'James Okafor'),
    ('seed086-i6-l2-r2-p2', 'seed086-i6-l2-r2', 'Extractor fan working, grille dusty.',          1, 'seed:086', 'James Okafor');
END
GO
