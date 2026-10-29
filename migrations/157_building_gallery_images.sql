-- 157_building_gallery_images — the table 072 declared but prod never got.
--
-- 072_building_gallery.sql is recorded as applied, yet production (and so the
-- staging copy) has only dbo.GallerySlots with its three seeded rows; the
-- dbo.BuildingGalleryImages table and its indexes were never created. A 14 Oct
-- edit rewrote 072 with IF-guards hoping to re-run it, but the runner skips
-- applied files and refuses on a changed checksum, so 072 is restored to the
-- version that was applied and the missing pieces land here instead.
-- Fix-forward for the checksum drift found on the first staging deploy, 23 Oct.
--
-- Additive and re-runnable: each object is created only when missing.

IF OBJECT_ID(N'dbo.GallerySlots', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.GallerySlots (
    Id         INT           IDENTITY(1,1) PRIMARY KEY,
    Label      NVARCHAR(100) NOT NULL,
    SortOrder  INT           NOT NULL DEFAULT 0
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.GallerySlots)
  INSERT INTO dbo.GallerySlots (Label, SortOrder) VALUES
    (N'Main Room', 0),
    (N'Office 1',  1),
    (N'Office 2',  2);
GO

IF OBJECT_ID(N'dbo.BuildingGalleryImages', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.BuildingGalleryImages (
    Id         INT           IDENTITY(1,1) PRIMARY KEY,
    BuildingId INT           NOT NULL REFERENCES dbo.Buildings(BuildingID),
    SlotId     INT           NOT NULL REFERENCES dbo.GallerySlots(Id),
    ImageUrl   NVARCHAR(500) NOT NULL,
    CONSTRAINT UQ_BuildingGalleryImages_Slot UNIQUE (BuildingId, SlotId)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_BuildingGalleryImages_BuildingId' AND object_id = OBJECT_ID(N'dbo.BuildingGalleryImages'))
  CREATE INDEX IX_BuildingGalleryImages_BuildingId ON dbo.BuildingGalleryImages(BuildingId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_BuildingGalleryImages_SlotId' AND object_id = OBJECT_ID(N'dbo.BuildingGalleryImages'))
  CREATE INDEX IX_BuildingGalleryImages_SlotId ON dbo.BuildingGalleryImages(SlotId);
GO
