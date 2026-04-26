-- Migration 029: Fix accounts invoice approval limit
--
-- Migration 026 seeded accounts with NULL (unlimited) but the correct
-- limit is $1,000 (same as facilities). This corrects it.
--
-- Fully idempotent.

UPDATE dbo.ApprovalLimits
SET    MaxInvoiceAmount = 1000.00
WHERE  RoleName = 'accounts'
  AND  MaxInvoiceAmount IS NULL;
GO
