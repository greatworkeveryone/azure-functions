-- 190: tenant link purpose, and a small company settings table (PLAN §15, Connor 31 Oct 2026). Additive and idempotent.
--
--   TenantLinks.Purpose   what the link is for. NOT NULL, default 'requests': every existing link gets
--                  'requests', which is what they all were. CHECK lists the known purposes; a later purpose
--                  (e.g. 'costs') is added by a new migration that replaces the constraint.
--   OrgSettings    company-wide key/value settings, edited from Admin and ledgered with old and new values.
--                  First key: 'afterHoursPhone', the number tenants are told to ring about an urgent building
--                  problem after hours. Buildings.EmergencyPhone (migration 184) stays as a per-building override.
--
-- RUNBOOK: apply after 189. Then set the after-hours number in Admin; the tenant page cannot be switched on
-- until one exists (company setting, or an override for every building with an active tenancy).

IF COL_LENGTH('dbo.TenantLinks', 'Purpose') IS NULL
  ALTER TABLE dbo.TenantLinks ADD Purpose NVARCHAR(30) NOT NULL CONSTRAINT DF_TenantLinks_Purpose DEFAULT N'requests';
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_TenantLinks_Purpose' AND parent_object_id = OBJECT_ID('dbo.TenantLinks'))
  ALTER TABLE dbo.TenantLinks ADD CONSTRAINT CK_TenantLinks_Purpose CHECK (Purpose IN (N'requests'));
GO

IF OBJECT_ID('dbo.OrgSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.OrgSettings (
    SettingKey   NVARCHAR(100) NOT NULL CONSTRAINT PK_OrgSettings PRIMARY KEY,
    SettingValue NVARCHAR(500) NULL,
    UpdatedAt    DATETIME2     NOT NULL CONSTRAINT DF_OrgSettings_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy    NVARCHAR(200) NULL
  );
END
GO
