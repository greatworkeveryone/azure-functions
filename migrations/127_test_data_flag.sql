-- 127_test_data_flag — test records stay inside Floorplan (D9, WP58-lite).
--
-- IsTest marks a record made for testing. src/test-data.ts refuses every
-- egress for one (Graph mail, Planner, MYOB, WordPress, the digest) and the
-- list, count and export queries leave test records out unless an admin has
-- Show test data on. Admins and directors set it at create; only an admin
-- flips it afterwards (setTestFlag, ledgered).
--
-- Additive and re-runnable: one NOT NULL column with a named constant default
-- per table, each behind a column-exists guard. Existing rows read 0 (not a
-- test record); nothing is backfilled, rewritten or deleted.

IF COL_LENGTH(N'dbo.Jobs', N'IsTest') IS NULL
  ALTER TABLE dbo.Jobs ADD IsTest BIT NOT NULL CONSTRAINT DF_Jobs_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Tenants', N'IsTest') IS NULL
  ALTER TABLE dbo.Tenants ADD IsTest BIT NOT NULL CONSTRAINT DF_Tenants_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Inspections', N'IsTest') IS NULL
  ALTER TABLE dbo.Inspections ADD IsTest BIT NOT NULL CONSTRAINT DF_Inspections_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Keys', N'IsTest') IS NULL
  ALTER TABLE dbo.Keys ADD IsTest BIT NOT NULL CONSTRAINT DF_Keys_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.KeyCheckouts', N'IsTest') IS NULL
  ALTER TABLE dbo.KeyCheckouts ADD IsTest BIT NOT NULL CONSTRAINT DF_KeyCheckouts_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Vacancies', N'IsTest') IS NULL
  ALTER TABLE dbo.Vacancies ADD IsTest BIT NOT NULL CONSTRAINT DF_Vacancies_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Emails', N'IsTest') IS NULL
  ALTER TABLE dbo.Emails ADD IsTest BIT NOT NULL CONSTRAINT DF_Emails_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Quotes', N'IsTest') IS NULL
  ALTER TABLE dbo.Quotes ADD IsTest BIT NOT NULL CONSTRAINT DF_Quotes_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.JobInvoices', N'IsTest') IS NULL
  ALTER TABLE dbo.JobInvoices ADD IsTest BIT NOT NULL CONSTRAINT DF_JobInvoices_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.PurchaseOrders', N'IsTest') IS NULL
  ALTER TABLE dbo.PurchaseOrders ADD IsTest BIT NOT NULL CONSTRAINT DF_PurchaseOrders_IsTest DEFAULT 0;
GO

IF COL_LENGTH(N'dbo.Payments', N'IsTest') IS NULL
  ALTER TABLE dbo.Payments ADD IsTest BIT NOT NULL CONSTRAINT DF_Payments_IsTest DEFAULT 0;
