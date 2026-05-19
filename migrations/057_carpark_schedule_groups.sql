-- m057 — carpark schedule groups
-- Stores per-tenant carpark groups as JSON, parallel to ScheduledRateSteps.
-- Each group tracks a label, which bays it covers, its starting monthly rate,
-- and the ISO date it commenced, so the schedule panel can compound the same
-- percentage increases as the main rent.

ALTER TABLE dbo.Tenants
  ADD CarparkScheduleGroups NVARCHAR(MAX) NULL;
GO
