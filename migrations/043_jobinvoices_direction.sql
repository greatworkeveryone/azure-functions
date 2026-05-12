-- 043_jobinvoices_direction.sql
--
-- Adds a Direction column to dbo.JobInvoices so we can distinguish:
--   • 'incoming'  — contractor invoice we receive (existing behaviour;
--                   approval transitions the job to Done).
--   • 'outgoing'  — invoice we raise to a tenant for an on-charge
--                   recoup (created by the oncharge form on the Invoices
--                   step; future MYOB sync target).
--
-- Existing rows are all incoming by definition (they pre-date this split),
-- so we backfill DEFAULT='incoming' and set NOT NULL after the backfill.
-- The /approveJobInvoice handler is being updated to skip the auto-Done
-- transition for outgoing rows; the column is what tells it which is which.
--
-- Each step is its own batch (separated by GO). SQL Server compiles a batch
-- up front, so a single batch containing both `ALTER TABLE ADD Direction`
-- and `UPDATE … SET Direction = …` errors with "Invalid column name" — the
-- backfill statement is parsed against the pre-ADD schema. Splitting into
-- batches lets each one see the schema produced by the previous batch.
--
-- Re-runnable.

-- Step 1: add the column with a default so existing INSERTs keep working
-- through the brief window before the NOT NULL clamp lands.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'Direction'
)
  ALTER TABLE dbo.JobInvoices
    ADD Direction NVARCHAR(20) NULL
        CONSTRAINT DF_JobInvoices_Direction DEFAULT ('incoming');
GO

-- Step 2: backfill any pre-existing rows (they're all incoming by definition).
UPDATE dbo.JobInvoices SET Direction = 'incoming' WHERE Direction IS NULL;
GO

-- Step 3: clamp to NOT NULL so future inserts can't bypass the column.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices')
    AND name = 'Direction'
    AND is_nullable = 1
)
  ALTER TABLE dbo.JobInvoices
    ALTER COLUMN Direction NVARCHAR(20) NOT NULL;
GO
