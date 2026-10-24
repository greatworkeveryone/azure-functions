-- Migration 178: usage analytics (PLAN §14, package UA1).
--
-- Four new tables. Nothing existing is touched.
--
--   dbo.UsageDevices    one row per browser that has reported use. DeviceId is random, made and
--                       kept by the browser (never a fingerprint): "d_" ids live in the browser's
--                       storage, "s_" ids last one session where storage is blocked. DeviceClass is
--                       phone, tablet or desktop (screen size and touch), with the browser and OS
--                       FAMILY only (no versions). Label is the name an admin gives a shared device
--                       ("Facilities tablet"), with who gave it and when.
--   dbo.UsageSessions   one browser session: who (AppUsers.UserID, from the verified token only),
--                       on which device, when it started, its last heartbeat and its active
--                       seconds (heartbeats while the page was visible and in use).
--   dbo.UsageViews      the page segments of a session: a MODULE key from the navigation and a
--                       route PATTERN ("/jobs/[id]", never an id or a query string), when it was
--                       entered and the active seconds spent. A long stay is split into segments
--                       (IsContinuation = 1) so active time lands in the right hour.
--   dbo.UsageDaily      the roll-up: one row per Darwin day x person x module x device class, with
--                       sessions, views and active seconds. ModuleKey '*' holds the day's totals
--                       for that person and class (distinct sessions, all views, all seconds), so
--                       sessions a day and active people never have to add module rows up.
--
-- Never stored: what a person types, page content, record contents, precise location.
--
-- Raw rows (UsageSessions, UsageViews) are kept for USAGE_RETENTION_DAYS (default 180) and may be
-- purged by the opt-in usagePurgeTimer, and only once their Darwin day has been rolled up after
-- the day ended. UsageDaily and UsageDevices are kept.
--
-- Additive and re-runnable: everything sits behind IF OBJECT_ID / IF NOT EXISTS, no existing data
-- is dropped, deleted or rewritten, and the new tables start empty. Tracking itself is off until
-- USAGE_TRACKING_ENABLED is "true" on the Function App.
--
-- RUNBOOK: apply 178 before turning on the usageAnalytics flag or any USAGE_* switch. Dry-run it on
-- a restored copy of production first (database-safety rules, section 4). Number 178 is reserved
-- for UA1. Never renumber.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.UsageDevices', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UsageDevices (
    DeviceId      NVARCHAR(40)  NOT NULL,
    FirstSeenAt   DATETIME2(3)  NOT NULL CONSTRAINT DF_UsageDevices_FirstSeenAt DEFAULT SYSUTCDATETIME(),
    LastSeenAt    DATETIME2(3)  NOT NULL CONSTRAINT DF_UsageDevices_LastSeenAt DEFAULT SYSUTCDATETIME(),
    DeviceClass   VARCHAR(8)    NOT NULL,
    BrowserFamily NVARCHAR(24)  NOT NULL,
    OsFamily      NVARCHAR(24)  NOT NULL,
    IsPersistent  BIT           NOT NULL CONSTRAINT DF_UsageDevices_IsPersistent DEFAULT 1,
    Label         NVARCHAR(80)  NULL,
    LabelledBy    NVARCHAR(200) NULL,
    LabelledAt    DATETIME2(3)  NULL,
    CONSTRAINT PK_UsageDevices PRIMARY KEY CLUSTERED (DeviceId),
    CONSTRAINT CK_UsageDevices_Class CHECK (DeviceClass IN ('phone', 'tablet', 'desktop')),
    CONSTRAINT CK_UsageDevices_Label CHECK (
      (Label IS NULL AND LabelledBy IS NULL AND LabelledAt IS NULL) OR (Label IS NOT NULL AND LabelledBy IS NOT NULL AND LabelledAt IS NOT NULL)
    )
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageDevices_Label' AND object_id = OBJECT_ID('dbo.UsageDevices'))
  CREATE INDEX IX_UsageDevices_Label ON dbo.UsageDevices (Label) WHERE Label IS NOT NULL;
GO

IF OBJECT_ID('dbo.UsageSessions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UsageSessions (
    SessionId       NVARCHAR(40) NOT NULL,
    UserId          INT          NOT NULL,
    DeviceId        NVARCHAR(40) NOT NULL,
    StartedAt       DATETIME2(3) NOT NULL CONSTRAINT DF_UsageSessions_StartedAt DEFAULT SYSUTCDATETIME(),
    LastHeartbeatAt DATETIME2(3) NOT NULL CONSTRAINT DF_UsageSessions_LastHeartbeatAt DEFAULT SYSUTCDATETIME(),
    ActiveSeconds   INT          NOT NULL CONSTRAINT DF_UsageSessions_ActiveSeconds DEFAULT 0,
    CONSTRAINT PK_UsageSessions PRIMARY KEY CLUSTERED (SessionId),
    CONSTRAINT FK_UsageSessions_User FOREIGN KEY (UserId) REFERENCES dbo.AppUsers (UserID),
    CONSTRAINT FK_UsageSessions_Device FOREIGN KEY (DeviceId) REFERENCES dbo.UsageDevices (DeviceId),
    CONSTRAINT CK_UsageSessions_Seconds CHECK (ActiveSeconds >= 0)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageSessions_User' AND object_id = OBJECT_ID('dbo.UsageSessions'))
  CREATE INDEX IX_UsageSessions_User ON dbo.UsageSessions (UserId, StartedAt) INCLUDE (DeviceId, ActiveSeconds, LastHeartbeatAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageSessions_Started' AND object_id = OBJECT_ID('dbo.UsageSessions'))
  CREATE INDEX IX_UsageSessions_Started ON dbo.UsageSessions (StartedAt) INCLUDE (UserId, DeviceId, ActiveSeconds);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageSessions_Device' AND object_id = OBJECT_ID('dbo.UsageSessions'))
  CREATE INDEX IX_UsageSessions_Device ON dbo.UsageSessions (DeviceId);
GO

IF OBJECT_ID('dbo.UsageViews', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UsageViews (
    ViewId         BIGINT        IDENTITY(1,1) NOT NULL,
    SessionId      NVARCHAR(40)  NOT NULL,
    ViewSeq        INT           NOT NULL,
    ModuleKey      NVARCHAR(64)  NOT NULL,
    RoutePattern   NVARCHAR(120) NOT NULL,
    EnteredAt      DATETIME2(3)  NOT NULL,
    ActiveSeconds  INT           NOT NULL CONSTRAINT DF_UsageViews_ActiveSeconds DEFAULT 0,
    IsContinuation BIT           NOT NULL CONSTRAINT DF_UsageViews_IsContinuation DEFAULT 0,
    CONSTRAINT PK_UsageViews PRIMARY KEY CLUSTERED (ViewId),
    CONSTRAINT FK_UsageViews_Session FOREIGN KEY (SessionId) REFERENCES dbo.UsageSessions (SessionId),
    CONSTRAINT CK_UsageViews_Seconds CHECK (ActiveSeconds >= 0)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_UsageViews_Seq' AND object_id = OBJECT_ID('dbo.UsageViews'))
  CREATE UNIQUE INDEX UX_UsageViews_Seq ON dbo.UsageViews (SessionId, ViewSeq);
GO

-- The hour x weekday heatmap and the roll-up read by time.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageViews_Entered' AND object_id = OBJECT_ID('dbo.UsageViews'))
  CREATE INDEX IX_UsageViews_Entered ON dbo.UsageViews (EnteredAt) INCLUDE (SessionId, ModuleKey, ActiveSeconds, IsContinuation);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageViews_Module' AND object_id = OBJECT_ID('dbo.UsageViews'))
  CREATE INDEX IX_UsageViews_Module ON dbo.UsageViews (ModuleKey, EnteredAt) INCLUDE (SessionId, ActiveSeconds);
GO

IF OBJECT_ID('dbo.UsageDaily', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UsageDaily (
    Day           DATE         NOT NULL,
    UserId        INT          NOT NULL,
    ModuleKey     NVARCHAR(64) NOT NULL,
    DeviceClass   VARCHAR(8)   NOT NULL,
    Sessions      INT          NOT NULL CONSTRAINT DF_UsageDaily_Sessions DEFAULT 0,
    Views         INT          NOT NULL CONSTRAINT DF_UsageDaily_Views DEFAULT 0,
    ActiveSeconds INT          NOT NULL CONSTRAINT DF_UsageDaily_ActiveSeconds DEFAULT 0,
    RolledUpAt    DATETIME2(3) NOT NULL CONSTRAINT DF_UsageDaily_RolledUpAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_UsageDaily PRIMARY KEY CLUSTERED (Day, UserId, ModuleKey, DeviceClass),
    CONSTRAINT FK_UsageDaily_User FOREIGN KEY (UserId) REFERENCES dbo.AppUsers (UserID),
    CONSTRAINT CK_UsageDaily_Class CHECK (DeviceClass IN ('phone', 'tablet', 'desktop'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageDaily_User' AND object_id = OBJECT_ID('dbo.UsageDaily'))
  CREATE INDEX IX_UsageDaily_User ON dbo.UsageDaily (UserId, Day) INCLUDE (ModuleKey, DeviceClass, Sessions, Views, ActiveSeconds);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UsageDaily_Module' AND object_id = OBJECT_ID('dbo.UsageDaily'))
  CREATE INDEX IX_UsageDaily_Module ON dbo.UsageDaily (ModuleKey, Day) INCLUDE (UserId, DeviceClass, Sessions, Views, ActiveSeconds);
GO
