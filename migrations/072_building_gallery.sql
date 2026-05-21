-- azure-functions/migrations/072_building_gallery.sql

CREATE TABLE dbo.GallerySlots (
  Id         INT           IDENTITY(1,1) PRIMARY KEY,
  Label      NVARCHAR(100) NOT NULL,
  SortOrder  INT           NOT NULL DEFAULT 0
);

INSERT INTO dbo.GallerySlots (Label, SortOrder) VALUES
  ('Main Room', 0),
  ('Office 1',  1),
  ('Office 2',  2);

CREATE TABLE dbo.BuildingGalleryImages (
  Id         INT           IDENTITY(1,1) PRIMARY KEY,
  BuildingId INT           NOT NULL REFERENCES dbo.Buildings(BuildingID),
  SlotId     INT           NOT NULL REFERENCES dbo.GallerySlots(Id),
  ImageUrl   NVARCHAR(500) NOT NULL,
  CONSTRAINT UQ_BuildingGalleryImages_Slot UNIQUE (BuildingId, SlotId)
);

CREATE INDEX IX_BuildingGalleryImages_BuildingId ON dbo.BuildingGalleryImages(BuildingId);
CREATE INDEX IX_BuildingGalleryImages_SlotId ON dbo.BuildingGalleryImages(SlotId);
