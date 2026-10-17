-- azure-functions/migrations/072_building_gallery.sql
-- Re-runnable: prod has GallerySlots (seeded) but not BuildingGalleryImages.

IF OBJECT_ID('dbo.GallerySlots', 'U') IS NULL
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
    ('Main Room', 0),
    ('Office 1',  1),
    ('Office 2',  2);
GO

IF OBJECT_ID('dbo.BuildingGalleryImages', 'U') IS NULL
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

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BuildingGalleryImages_BuildingId' AND object_id = OBJECT_ID('dbo.BuildingGalleryImages'))
  CREATE INDEX IX_BuildingGalleryImages_BuildingId ON dbo.BuildingGalleryImages(BuildingId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BuildingGalleryImages_SlotId' AND object_id = OBJECT_ID('dbo.BuildingGalleryImages'))
  CREATE INDEX IX_BuildingGalleryImages_SlotId ON dbo.BuildingGalleryImages(SlotId);
GO
