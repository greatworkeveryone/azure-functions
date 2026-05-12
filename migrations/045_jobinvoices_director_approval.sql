-- 045_jobinvoices_director_approval.sql
--
-- Adds stage-2 ("Director") approval to dbo.JobInvoices.
-- The Status column gains a new value 'director_approved'; no schema change
-- is needed for that since the column is unconstrained NVARCHAR(20) (per
-- m017). Two audit columns track who/when, mirroring ApprovedAt/By:
--
--   DirectorApprovedAt DATETIME2  -- UTC timestamp of the director sign-off.
--   DirectorApprovedBy NVARCHAR   -- caller name from the JWT.
--
-- Status flow:  pending -> approved -> director_approved -> (myob creation)
--               and `rejected` from any earlier stage.
--
-- Also seeds the 'director' RoleName in dbo.ApprovalLimits with NULL
-- (unlimited) for symmetry; the directorApproveJobInvoice handler does not
-- consult this row today (role membership is sufficient), but it leaves room
-- for a future limit without another migration.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'DirectorApprovedAt'
)
  ALTER TABLE dbo.JobInvoices ADD DirectorApprovedAt DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'DirectorApprovedBy'
)
  ALTER TABLE dbo.JobInvoices ADD DirectorApprovedBy NVARCHAR(200) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'director')
  INSERT INTO dbo.ApprovalLimits (RoleName, MaxInvoiceAmount) VALUES ('director', NULL);
GO
`
