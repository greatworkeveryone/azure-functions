-- azure-functions/migrations/073_building_hero_image.sql
-- Replace per-slot building gallery images with a single hero image per building.

DROP TABLE IF EXISTS dbo.BuildingGalleryImages;

ALTER TABLE dbo.Buildings
  ADD HeroImageUrl NVARCHAR(500) NULL;
