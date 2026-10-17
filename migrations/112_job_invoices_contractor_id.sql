-- Migration 112: record which contractor an invoice is from.
--
-- JobInvoices has only ever kept the contractor's name. A name can be
-- misspelt, renamed or shared, so anything that has to say who an invoice was
-- for (the decision ledger, the trend reports built on it) needs the id the
-- quote and the purchase order already carry. Invoices get a ContractorID;
-- Payments follow the invoice they pay.
--
-- The id is filled when an invoice is created, wherever the request names the
-- contractor by id (the picker, the quote or order the invoice answers). An
-- invoice that only has free text keeps NULL here and the ledger falls back to
-- the one dbo.Contractors row with that exact name. There is no backfill:
-- production has no invoices yet, and rows made before this keep the name.
--
-- Additive and re-runnable: every statement is behind an existence check, the
-- new column is NULLable, and no existing row is touched. The column, the
-- foreign key and the index each get their own batch because a batch is
-- compiled before it runs, so a statement can't reference a column the same
-- batch creates.
--
-- The foreign key needs a single-column unique key to point at. dbo.Contractors
-- is keyed on its own Id; its ContractorID (the myBuildings id) carries a UNIQUE
-- constraint (migration 002), which is what the key references. If a database
-- doesn't have that, the key is skipped with a message rather than stopping the
-- API at startup, and the column and index still go in.

IF COL_LENGTH('dbo.JobInvoices', 'ContractorID') IS NULL
  ALTER TABLE dbo.JobInvoices ADD ContractorID INT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
   WHERE name = 'FK_JobInvoices_Contractors'
     AND parent_object_id = OBJECT_ID('dbo.JobInvoices')
)
AND EXISTS (
  -- A unique index (or constraint) on exactly ContractorID, no filter.
  SELECT 1
    FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
   WHERE i.object_id = OBJECT_ID('dbo.Contractors')
     AND i.is_unique = 1
     AND i.has_filter = 0
     AND ic.is_included_column = 0
     AND c.name = 'ContractorID'
     AND (
       SELECT COUNT(*) FROM sys.index_columns k
        WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.is_included_column = 0
     ) = 1
)
  ALTER TABLE dbo.JobInvoices ADD CONSTRAINT FK_JobInvoices_Contractors
    FOREIGN KEY (ContractorID) REFERENCES dbo.Contractors(ContractorID);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
   WHERE name = 'FK_JobInvoices_Contractors'
     AND parent_object_id = OBJECT_ID('dbo.JobInvoices')
)
  PRINT N'112: dbo.Contractors has no single-column unique key on ContractorID, so JobInvoices.ContractorID has no foreign key';
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_JobInvoices_ContractorID'
     AND object_id = OBJECT_ID('dbo.JobInvoices')
)
  CREATE INDEX IX_JobInvoices_ContractorID ON dbo.JobInvoices(ContractorID);
GO
