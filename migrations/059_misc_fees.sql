-- m059: misc fees per tenant
-- Stores each tenant's miscellaneous fees (air con, cleaning, etc.) as a JSON array.
-- Rate steps follow the same auto/manual/CPI/fixed/market logic as carpark groups.

IF NOT EXISTS (SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Tenants') AND name = 'MiscFees')
  ALTER TABLE dbo.Tenants ADD MiscFees NVARCHAR(MAX) NULL;
GO
