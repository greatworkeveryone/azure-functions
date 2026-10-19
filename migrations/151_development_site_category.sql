-- Apply before accepting development sites through the manual buildings API.
-- Category is organisational only; all existing access gates still apply.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID('dbo.CK_Buildings_Category', 'C') IS NOT NULL
  ALTER TABLE dbo.Buildings DROP CONSTRAINT CK_Buildings_Category;
ALTER TABLE dbo.Buildings WITH CHECK ADD CONSTRAINT CK_Buildings_Category
  CHECK (Category IN (N'commercial', N'residence', N'development'));
COMMIT;
GO
-- DESTRUCTIVE: replace category CHECK with a superset for the requested Development Sites folder; no rows removed · approved by Connor Randazzo 2026-10-19
