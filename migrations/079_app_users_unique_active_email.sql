-- Migration 079: Filtered unique index on AppUsers(Email) WHERE IsActive = 1.
-- Backs the application-level duplicate-email check in upsertAppUser so a race
-- between two concurrent invites can't produce two active rows with the same
-- email. The base UQ_AppUsers_Email constraint already enforces uniqueness
-- across ALL rows; this filtered index narrows enforcement to active rows so
-- soft-deleted (IsActive = 0) historical rows don't block re-inviting the same
-- address. If the base constraint is later dropped, this index keeps the
-- application invariant intact.

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UX_AppUsers_Email_Active'
    AND object_id = OBJECT_ID('dbo.AppUsers')
)
BEGIN
  CREATE UNIQUE INDEX UX_AppUsers_Email_Active
    ON dbo.AppUsers(Email)
    WHERE IsActive = 1;
  PRINT 'Created UX_AppUsers_Email_Active index';
END;
GO
