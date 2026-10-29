-- azure-functions/migrations/074_vacancy_slot_images.sql
-- Store per-slot images on each vacancy (JSON map of slotLabel → imageUrl).

ALTER TABLE dbo.Vacancies
  ADD SlotImages NVARCHAR(MAX) NULL;
