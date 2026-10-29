-- Migration 155: money_send_claims_director_required (audit 2026-10-23, data integrity)
--
-- Additive and re-runnable: five nullable columns, each behind a column-exists
-- guard. Nothing is backfilled, rewritten or deleted.
--
--   JobInvoices.DirectorRequiredAt      Set when stage 1 approves an invoice that
--       still needs a director. markJobInvoiceMyobCreated and the payment check
--       read it, so a later change of threshold cannot make an under-authority
--       approval final. Invoices approved before this column keep the old
--       behaviour (the requirement is recomputed from the current threshold).
--   PurchaseOrders.SendAttemptedAt/By   A send claim, taken before the mail
--       leaves and cleared once SentAt is stamped (or the send fails). A claim
--       that is still there means the mail may have gone without being
--       recorded, so a second send is refused until a person has checked.
--   Quotes/JobInvoices.DirectorEmailAttemptedAt   The same claim for the
--       director approval request.
--
-- Undo: nothing reads these columns but the code in this release; dropping them
-- is a separate reviewed migration.

SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  IF COL_LENGTH(N'dbo.JobInvoices', N'DirectorRequiredAt') IS NULL
    ALTER TABLE dbo.JobInvoices ADD DirectorRequiredAt DATETIME2 NULL;

  IF COL_LENGTH(N'dbo.PurchaseOrders', N'SendAttemptedAt') IS NULL
    ALTER TABLE dbo.PurchaseOrders ADD SendAttemptedAt DATETIME2 NULL;

  IF COL_LENGTH(N'dbo.PurchaseOrders', N'SendAttemptedBy') IS NULL
    ALTER TABLE dbo.PurchaseOrders ADD SendAttemptedBy NVARCHAR(255) NULL;

  IF COL_LENGTH(N'dbo.Quotes', N'DirectorEmailAttemptedAt') IS NULL
    ALTER TABLE dbo.Quotes ADD DirectorEmailAttemptedAt DATETIME2 NULL;

  IF COL_LENGTH(N'dbo.JobInvoices', N'DirectorEmailAttemptedAt') IS NULL
    ALTER TABLE dbo.JobInvoices ADD DirectorEmailAttemptedAt DATETIME2 NULL;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
