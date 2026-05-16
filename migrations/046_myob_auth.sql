-- 046_myob_auth.sql
--
-- OAuth 2.0 token storage for the MYOB AccountRight integration.
--
-- Single-row table (Id = 1) because there's only ever one MYOB account
-- linked to the system. The CHECK constraint prevents accidental inserts of
-- a second row.
--
-- MYOB access tokens expire after ~20 minutes; the refresh token is used to
-- obtain a new pair (MYOB also rotates the refresh token on each refresh, so
-- the row is overwritten on every refresh).
--
-- Re-runnable.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'MyobAuth'
)
BEGIN
  CREATE TABLE dbo.MyobAuth (
    Id              INT             NOT NULL PRIMARY KEY CHECK (Id = 1),
    AccessToken     NVARCHAR(MAX)   NOT NULL,
    RefreshToken    NVARCHAR(MAX)   NOT NULL,
    ExpiresAt       DATETIME2       NOT NULL,
    Scope           NVARCHAR(500)   NULL,
    AuthorizedBy    NVARCHAR(200)   NULL,
    AuthorizedAt    DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt       DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO
