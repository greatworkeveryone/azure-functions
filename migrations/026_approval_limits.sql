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

  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('facilities_staff',    1000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('facilities_manager', 10000.00);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('accounts',               NULL);
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('Admin',                  NULL);
END
GO
