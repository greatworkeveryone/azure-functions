-- Migration 033: KeyCheckoutBatches.CheckOutPhotoBlobUrl is now nullable.
--
-- Codes (ItemType = 'code') don't need a handover photo — there's no physical
-- artefact to record being passed across. Physical keys still require a photo,
-- but that's enforced at the application layer (checkoutKeys handler), not via
-- a column-level NOT NULL constraint, since the same row can cover a mix of
-- keys and codes only when *all* are codes.
--
-- Fully idempotent.

IF EXISTS (
  SELECT 1
    FROM sys.columns
   WHERE object_id = OBJECT_ID('dbo.KeyCheckoutBatches')
     AND name = 'CheckOutPhotoBlobUrl'
     AND is_nullable = 0
)
BEGIN
  ALTER TABLE dbo.KeyCheckoutBatches
    ALTER COLUMN CheckOutPhotoBlobUrl NVARCHAR(500) NULL;
END
GO
