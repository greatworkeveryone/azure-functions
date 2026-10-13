-- Migration 096: tenancy write integrity (PLAN WP23a + WP23b).
--
--   RowVersion       optimistic concurrency for tenant writes: a write carries
--                    the version it read and a mismatch is a 409.
--   ScheduleVersion  bumped by every schedule write (rate steps, car park
--                    groups, misc fees, incentives, schedule terms), checked
--                    under UPDLOCK so concurrent schedule edits can't lose one.
--   ReviewRatchet    lease clause "no rent decrease on review" (WP23b).
--
-- Additive and idempotent: each column is added only when missing, existing
-- rows take the defaults, nothing is dropped or rewritten. Runs at startup
-- (functions/startup.ts → migrate.ts); safe to re-run.

IF COL_LENGTH('dbo.Tenants', 'RowVersion') IS NULL
  ALTER TABLE dbo.Tenants ADD RowVersion ROWVERSION;
GO

IF COL_LENGTH('dbo.Tenants', 'ScheduleVersion') IS NULL
  ALTER TABLE dbo.Tenants
    ADD ScheduleVersion INT NOT NULL
      CONSTRAINT DF_Tenants_ScheduleVersion DEFAULT 0;
GO

IF COL_LENGTH('dbo.Tenants', 'ReviewRatchet') IS NULL
  ALTER TABLE dbo.Tenants
    ADD ReviewRatchet BIT NOT NULL
      CONSTRAINT DF_Tenants_ReviewRatchet DEFAULT 0;
GO
