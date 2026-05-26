-- 075_db_driven_roles.sql
-- Allow pre-invited users (no OID yet), track who invited them, audit role changes.

-- 1. Make EntraOid nullable so we can pre-create users before first login.
ALTER TABLE dbo.AppUsers ALTER COLUMN EntraOid NVARCHAR(255) NULL;

-- 2. Drop the existing unique constraint on EntraOid (SQL Server only allows
--    one NULL in a regular UNIQUE constraint — filtered index handles this better).
DECLARE @constraintName NVARCHAR(200);
SELECT @constraintName = kc.name
FROM   sys.key_constraints kc
JOIN   sys.index_columns  ic ON kc.unique_index_id = ic.index_id
                              AND kc.parent_object_id = ic.object_id
JOIN   sys.columns        c  ON ic.object_id = c.object_id
                              AND ic.column_id = c.column_id
WHERE  kc.type = 'UQ'
  AND  OBJECT_NAME(kc.parent_object_id) = 'AppUsers'
  AND  c.name = 'EntraOid';
IF @constraintName IS NOT NULL
  EXEC('ALTER TABLE dbo.AppUsers DROP CONSTRAINT ' + @constraintName);

-- Drop any standalone unique index with a different name.
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE  object_id = OBJECT_ID('dbo.AppUsers') AND name = 'UQ_AppUsers_EntraOid'
)
  DROP INDEX UQ_AppUsers_EntraOid ON dbo.AppUsers;

-- 3. Re-add as a filtered unique index — allows multiple NULLs (pending invites).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE  object_id = OBJECT_ID('dbo.AppUsers') AND name = 'IX_AppUsers_EntraOid'
)
  CREATE UNIQUE INDEX IX_AppUsers_EntraOid
    ON dbo.AppUsers(EntraOid)
    WHERE EntraOid IS NOT NULL;

-- 4. Invite tracking: who sent the invite and when.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE  object_id = OBJECT_ID('dbo.AppUsers') AND name = 'InvitedByOid'
)
  ALTER TABLE dbo.AppUsers ADD InvitedByOid NVARCHAR(100) NULL;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE  object_id = OBJECT_ID('dbo.AppUsers') AND name = 'InvitedAt'
)
  ALTER TABLE dbo.AppUsers ADD InvitedAt DATETIME2 NULL;

-- 5. Audit table — immutable record of every role change.
-- No FK on TargetUserID: audit records are intentionally permanent even if a user
-- is later deactivated. AppUsers uses IsActive for soft deletes, not hard deletes.
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID('dbo.UserRoleAudit'))
  CREATE TABLE dbo.UserRoleAudit (
    AuditID             INT IDENTITY(1,1) PRIMARY KEY,
    ChangedByOid        NVARCHAR(100)  NOT NULL,
    ChangedByDisplayName NVARCHAR(200) NOT NULL,
    TargetUserID        INT            NOT NULL,
    TargetEmail         NVARCHAR(200)  NOT NULL,
    OldRole             NVARCHAR(50)   NULL,
    NewRole             NVARCHAR(50)   NULL,
    ChangedAt           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
  );
