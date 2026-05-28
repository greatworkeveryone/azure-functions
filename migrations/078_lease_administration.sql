-- Migration 078: Add LeaseAdministration JSON column to Tenants.
-- Stores a single object:
--   {
--     leaseDocuments: [{ id, displayOrder, docType, executedByLessee, executedByLessor,
--                        mortgageeConsent, registeredWithLto, scannedToFile, hardCopyFiled }],
--     otherDocuments: [{ id, label, fieldType, value, displayOrder }],   -- add/remove/rename
--     detailsEntered: [{ id, label, fieldType, value, displayOrder }],   -- add/remove/rename
--     leaseManager: { name, email } | null
--   }
-- fieldType is "date" (value = ISO date | "n/a"), "text", or "yesno" ("yes" | "no").
-- New tenancies are seeded with a standard set of fields; all are editable.
-- Follows the same JSON-in-column pattern as InfoSheetSections, MiscFees, Incentives, etc.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants')
    AND name = 'LeaseAdministration'
)
BEGIN
  ALTER TABLE dbo.Tenants ADD LeaseAdministration NVARCHAR(MAX) NULL;
  PRINT 'Added LeaseAdministration column to dbo.Tenants';
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints
  WHERE name = 'CK_Tenants_LeaseAdministration'
)
BEGIN
  ALTER TABLE dbo.Tenants
    ADD CONSTRAINT CK_Tenants_LeaseAdministration
      CHECK (LeaseAdministration IS NULL OR ISJSON(LeaseAdministration) = 1);
  PRINT 'Added CK_Tenants_LeaseAdministration constraint';
END;
GO
