-- azure-functions/migrations/074_vacancy_slot_images.sql
-- Store per-slot images on each vacancy (JSON map of slotLabel → imageUrl).

IF COL_LENGTH('dbo.Vacancies', 'SlotImages') IS NULL
  ALTER TABLE dbo.Vacancies
    ADD SlotImages NVARCHAR(MAX) NULL;
GO
