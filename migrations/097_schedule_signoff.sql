-- Migration 097: Per-tenancy schedule sign-off (PLAN WP24, beta sprint U2).
--
-- An accounts manager, the CFO or a director signs a tenancy's rent schedule
-- off as verified against the lease. Until then its dates and figures are
-- unverified: no 90/60/30-day lease tasks are raised for it and portfolio
-- figures say how many tenancies are not yet signed off.
--
--   Tenants.ScheduleSignedOffAt      when it was signed off (UTC); NULL = not signed off
--   Tenants.ScheduleSignedOffById    Entra object id of the person who signed
--   Tenants.ScheduleSignedOffByName  their name, so the record reads if they are renamed
--   Tenants.ScheduleSignOffNote      the optional note they left
--
-- Signing off, revoking it and a manual edit clearing it are decisions in the
-- ledger (schedule.sign_off, schedule.sign_off_revoke, schedule.sign_off_cleared);
-- these columns are only the current state.
--
-- Purely additive and re-runnable: every ADD COLUMN is guarded, all four are
-- NULL, so every existing tenancy reads as not signed off, which is true.
-- Nothing is dropped, deleted, altered or rewritten. The migration runner
-- (src/migrate.ts) splits on the GO lines and runs each batch on its own.

IF COL_LENGTH('dbo.Tenants', 'ScheduleSignedOffAt') IS NULL
    ALTER TABLE dbo.Tenants ADD ScheduleSignedOffAt DATETIME2 NULL;
GO

IF COL_LENGTH('dbo.Tenants', 'ScheduleSignedOffById') IS NULL
    ALTER TABLE dbo.Tenants ADD ScheduleSignedOffById NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.Tenants', 'ScheduleSignedOffByName') IS NULL
    ALTER TABLE dbo.Tenants ADD ScheduleSignedOffByName NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.Tenants', 'ScheduleSignOffNote') IS NULL
    ALTER TABLE dbo.Tenants ADD ScheduleSignOffNote NVARCHAR(500) NULL;
GO
