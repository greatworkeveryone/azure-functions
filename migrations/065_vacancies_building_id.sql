-- Migration 065: Replace Subtitle with BuildingId on Vacancies.
-- Subtitle was a free-text field; BuildingId links to the building picker.

ALTER TABLE dbo.Vacancies ADD BuildingId INT NULL;
ALTER TABLE dbo.Vacancies DROP COLUMN Subtitle;
GO
