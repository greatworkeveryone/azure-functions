-- Migration 026: ApprovalLimits
--
-- Stores per-role invoice approval limits. NULL means unlimited authority.
-- Roles mirror the Entra ID app role values used throughout the system.
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ApprovalLimits')
BEGIN
  CREATE TABLE dbo.ApprovalLimits (
    RoleName          NVARCHAR(100) NOT NULL,
    MaxInvoiceAmount  DECIMAL(18,2) NULL,   -- NULL = unlimited
    CONSTRAINT PK_ApprovalLimits PRIMARY KEY (RoleName)
  );

  -- RoleNames must match the Entra ID app role values defined in APP_ROLES (src/constants/roles.ts)
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('facilities',                       1000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('timesheet_approval_facilities',   10000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('timesheet_approval_accounts',     10000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('accounts',                         1000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('Admin',                              NULL);
END
GO
