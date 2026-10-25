-- Migration 131: access-pattern monitoring (beta sprint S10, decision 15).
--
--   dbo.AccessEvents          one row per sampled access: every sign-in
--                             (registerSelf), every money action (S11's gate),
--                             the first request per person per 15 minutes, and
--                             bursts. Anomaly holds the most serious rule that
--                             fired ('none' when nothing did); Detail holds the
--                             rest as JSON.
--   dbo.AppUsers.AccessProfile the person's expected use as JSON:
--                             { timeZone, hoursStart, hoursEnd, days, countries,
--                               callOutAllowed }. NULL = the role's default
--                             (Darwin, 06:00-20:00, Mon-Sat, AU; call-outs for
--                             facilities roles), applied in code, never stored.
--
-- Privacy: no raw address or user agent is stored, only keyed hashes
-- (src/access/clientIp.ts hashValue). Country is the client's own claim
-- (x-fp-country, from the browser's time zone); App Insights' geolocation is
-- the source of truth for alerts. City is reserved for that and stays NULL.
--
-- Retention: nothing here deletes. ~1-2k rows a day at pilot scale. A purge
-- of rows older than the 90-day device window would be a destructive migration
-- or timer and needs Connor's written approval first.
--
-- Purely additive and re-runnable: every CREATE and ADD is existence-guarded,
-- the new AppUsers column is NULL, nothing is dropped, deleted or rewritten.
-- The runner splits on GO, so the column is added in one batch and its CHECK
-- in the next.

IF OBJECT_ID('dbo.AccessEvents', 'U') IS NULL
  CREATE TABLE dbo.AccessEvents (
    AccessEventId BIGINT        IDENTITY(1,1) NOT NULL,
    Oid           NVARCHAR(64)  NOT NULL,
    Role          NVARCHAR(32)  NULL,
    At            DATETIME2(3)  NOT NULL CONSTRAINT DF_AccessEvents_At DEFAULT SYSUTCDATETIME(),
    IpHash        VARCHAR(64)   NULL,
    Country       NVARCHAR(2)   NULL,
    City          NVARCHAR(100) NULL,
    UserAgentHash VARCHAR(64)   NULL,
    LocalHour     TINYINT       NULL,
    Kind          NVARCHAR(16)  NOT NULL,
    Anomaly       NVARCHAR(16)  NOT NULL CONSTRAINT DF_AccessEvents_Anomaly DEFAULT N'none',
    Detail        NVARCHAR(2000) NULL,
    CONSTRAINT PK_AccessEvents PRIMARY KEY CLUSTERED (AccessEventId),
    CONSTRAINT CK_AccessEvents_Kind CHECK (Kind IN (N'signin', N'request', N'money')),
    CONSTRAINT CK_AccessEvents_Anomaly CHECK (Anomaly IN (N'none', N'new_country', N'outside_window', N'new_device', N'burst')),
    CONSTRAINT CK_AccessEvents_LocalHour CHECK (LocalHour IS NULL OR LocalHour BETWEEN 0 AND 23),
    CONSTRAINT CK_AccessEvents_DetailJson CHECK (Detail IS NULL OR ISJSON(Detail) = 1)
  );
GO

-- new_device: "has this person used this user agent in the last 90 days?"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AccessEvents_Oid_Device' AND object_id = OBJECT_ID('dbo.AccessEvents'))
  CREATE INDEX IX_AccessEvents_Oid_Device ON dbo.AccessEvents (Oid, UserAgentHash, At);
GO

-- The admin panel (last 7 days) and the daily report (last 24 hours).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AccessEvents_At' AND object_id = OBJECT_ID('dbo.AccessEvents'))
  CREATE INDEX IX_AccessEvents_At ON dbo.AccessEvents (At) INCLUDE (Oid, Kind, Anomaly);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.AppUsers') AND name = 'AccessProfile')
  ALTER TABLE dbo.AppUsers ADD AccessProfile NVARCHAR(1000) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_AppUsers_AccessProfileJson' AND parent_object_id = OBJECT_ID('dbo.AppUsers'))
  ALTER TABLE dbo.AppUsers ADD CONSTRAINT CK_AppUsers_AccessProfileJson CHECK (AccessProfile IS NULL OR ISJSON(AccessProfile) = 1);
GO
