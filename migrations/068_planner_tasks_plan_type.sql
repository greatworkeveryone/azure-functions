-- Migration 068: PlannerTasks — add PlanType column.
-- Existing rows are backfilled: tenancy triggers → 'accounts',
-- job_update_due → 'facilities'. New rows set this explicitly on insert.

ALTER TABLE dbo.PlannerTasks ADD PlanType VARCHAR(20) NULL;
GO

UPDATE dbo.PlannerTasks SET PlanType = 'accounts'
WHERE TriggerType IN ('lease_expiry', 'option_notice', 'rent_review');

UPDATE dbo.PlannerTasks SET PlanType = 'facilities'
WHERE TriggerType = 'job_update_due';
GO

ALTER TABLE dbo.PlannerTasks ALTER COLUMN PlanType VARCHAR(20) NOT NULL;
