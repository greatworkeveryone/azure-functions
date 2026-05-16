-- 049_rename_max_invoice_amount.sql
--
-- Renames dbo.ApprovalLimits.MaxInvoiceAmount → MaxApprovalAmount.
-- The same limit now governs both quote AND invoice approvals.
-- Re-runnable.

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.ApprovalLimits') AND name = 'MaxInvoiceAmount'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.ApprovalLimits') AND name = 'MaxApprovalAmount'
)
BEGIN
  EXEC sp_rename 'dbo.ApprovalLimits.MaxInvoiceAmount', 'MaxApprovalAmount', 'COLUMN';
END
GO
