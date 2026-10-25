-- Migration 083: Add IsContract flag to Jobs (WP10).
-- Standing-contract maintenance runs on a pre-agreed contractor: each job is
-- still billed (an invoice arrives per job) but there is no quoting round. A
-- contract job may move New → Work directly (WORK_AUTHORIZED), skipping the
-- quote states, while every financial control downstream (invoice approval,
-- approval limits, director tier, MYOB, payment) stays untouched.
--
-- The flag is strictly per-job, not per-contractor: re-tendering a contract's
-- contractor runs as a normal quoted job (isContract = 0). No contractor column
-- is added — the invoice already captures the contractor on contract jobs.
--
-- NOT NULL DEFAULT 0 backfills every existing row as non-contract, matching the
-- frontend's "treat missing as false" rule. Contract status may only be flipped
-- while the job is still New (changing it mid-flow would invalidate the path) —
-- that gate is enforced in the upsertJob handler, not the schema.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'IsContract'
)
BEGIN
  ALTER TABLE dbo.Jobs
    ADD IsContract BIT NOT NULL CONSTRAINT DF_Jobs_IsContract DEFAULT 0;
  PRINT 'Added IsContract column to dbo.Jobs';
END;
GO
