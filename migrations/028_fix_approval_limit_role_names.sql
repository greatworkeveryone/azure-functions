-- Migration 028: Fix ApprovalLimits role names
--
-- Migration 026 seeded wrong role names that don't match the Entra ID
-- app role values. This corrects them to match APP_ROLES in roles.ts:
--   'facilities_staff'   → 'facilities'
--   'facilities_manager' → 'timesheet_approval_facilities'
-- Also adds the missing 'timesheet_approval_accounts' row.
--
-- Fully idempotent.

-- Fix 'facilities_staff' → 'facilities'
IF EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_staff')
  AND NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'facilities')
BEGIN
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount)
    SELECT 'facilities', MaxInvoiceAmount FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_staff';
END
DELETE FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_staff';

-- Fix 'facilities_manager' → 'timesheet_approval_facilities'
IF EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_manager')
  AND NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'timesheet_approval_facilities')
BEGIN
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount)
    SELECT 'timesheet_approval_facilities', MaxInvoiceAmount FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_manager';
END
DELETE FROM dbo.ApprovalLimits WHERE RoleName = 'facilities_manager';

-- Add missing 'timesheet_approval_accounts' (same limit as facilities approval)
IF NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'timesheet_approval_accounts')
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('timesheet_approval_accounts', 10000.00);
GO
