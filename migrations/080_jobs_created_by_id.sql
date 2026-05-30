-- 050_jobs_created_by_id.sql
--
-- Adds dbo.Jobs.CreatedById — the verified Entra OID (NVARCHAR(64)) of the
-- user who created the job. Lets archive/unarchive authorisation compare an
-- immutable token-derived identifier instead of the existing CreatedBy
-- display-name string (which can be spoofed via JWT `name` claim and breaks
-- when a user is renamed).
--
-- Historical rows (created before this column existed) stay NULL — those
-- rows fall back to the legacy display-name compare in archive/unarchive.
-- New rows always populate CreatedById from verifiedIdentityFromRequest.
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'CreatedById'
)
  ALTER TABLE dbo.Jobs ADD CreatedById NVARCHAR(64) NULL;
GO
