-- Migration 025: PurchaseOrders — MYOB and completion tracking
--
-- Adds four columns to PurchaseOrders:
--   MyobCreatedAt / MyobCreatedBy — when the PO was recorded in MYOB
--   CompletedAt / CompletedBy     — when the work was marked complete
--
-- Fully idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PurchaseOrders') AND name = 'MyobCreatedAt')
  ALTER TABLE dbo.PurchaseOrders ADD MyobCreatedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PurchaseOrders') AND name = 'MyobCreatedBy')
  ALTER TABLE dbo.PurchaseOrders ADD MyobCreatedBy NVARCHAR(200) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PurchaseOrders') AND name = 'CompletedAt')
  ALTER TABLE dbo.PurchaseOrders ADD CompletedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PurchaseOrders') AND name = 'CompletedBy')
  ALTER TABLE dbo.PurchaseOrders ADD CompletedBy NVARCHAR(200) NULL;
GO
