-- Migration 018: Payment MYOB integration
--
-- Adds MYOB tracking fields to the Payments table:
--   Status        — pending (recorded, awaiting MYOB processing) |
--                   paid    (confirmed paid in MYOB)
--   MyobID        — MYOB Purchase Bill UID (GUID)
--   MyobURL       — direct link to the bill in the MYOB web app
--   MyobSyncedAt  — last time this payment was synced with MYOB
--
-- Existing payments are seeded as 'paid' because they were recorded under the
-- old flow where recording = confirmed payment.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Payments') AND name = 'Status')
BEGIN
  ALTER TABLE dbo.Payments ADD Status NVARCHAR(20) NOT NULL
    CONSTRAINT DF_Payments_Status DEFAULT 'pending';
  -- Dynamic SQL defers column resolution until after ALTER TABLE has run.
  EXEC('UPDATE dbo.Payments SET Status = ''paid''');
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Payments') AND name = 'MyobID')
  ALTER TABLE dbo.Payments ADD MyobID NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Payments') AND name = 'MyobURL')
  ALTER TABLE dbo.Payments ADD MyobURL NVARCHAR(500) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Payments') AND name = 'MyobSyncedAt')
  ALTER TABLE dbo.Payments ADD MyobSyncedAt DATETIME2 NULL;
GO
