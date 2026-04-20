-- Migration 011: On-chargeable jobs.
--
-- A job is "on-chargeable" when some portion of its cost is passed on to
-- the tenant (e.g. damage caused by tenant activity, upgrades they asked
-- for). The flag alone flips the UI on; the amount + notes capture what
-- we intend to recoup and why.
--
-- Column choices:
--   IsOnchargeable  → NOT NULL DEFAULT 0 so legacy rows slot in as "no"
--                     without a separate backfill.
--   OnchargeAmount  → NULL so the flag can turn on before the user knows
--                     the dollar figure (e.g. before the invoice lands).
--   OnchargeNotes   → free text, NULL by default.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'IsOnchargeable')
  ALTER TABLE dbo.Jobs
    ADD IsOnchargeable BIT NOT NULL CONSTRAINT DF_Jobs_IsOnchargeable DEFAULT 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'OnchargeAmount')
  ALTER TABLE dbo.Jobs ADD OnchargeAmount DECIMAL(18,2) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'OnchargeNotes')
  ALTER TABLE dbo.Jobs ADD OnchargeNotes NVARCHAR(MAX) NULL;
GO
