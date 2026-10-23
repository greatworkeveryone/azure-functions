-- 159_alert_send_log — shared rate cap for the Teams Workflows alert route (stage 1).
--
-- Microsoft allows 25 Flow-bot posts per 5 minutes per connection; Floorplan caps itself at
-- 20 (src/alerts/rateCap.ts). Flex Consumption runs several instances, so the count lives
-- here, not in memory. One row per post claimed; a claim is one atomic INSERT ... WHERE the
-- last 5 minutes hold fewer than the cap. Nothing deletes; pruning old rows, if ever needed, is its
-- own reviewed job (database-safety rule 2).
--
-- Additive and re-runnable. The code probes for the table (OBJECT_ID), and while it is absent
-- it allows no workflows posts at all (everything goes by email), so deploying first is safe.

IF OBJECT_ID(N'dbo.AlertSendLog', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AlertSendLog (
    AlertSendLogId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AlertSendLog PRIMARY KEY,
    Channel        NVARCHAR(32)  NOT NULL,
    SentAt         DATETIME2(3)  NOT NULL CONSTRAINT DF_AlertSendLog_SentAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AlertSendLog_Channel_SentAt' AND object_id = OBJECT_ID(N'dbo.AlertSendLog'))
  CREATE INDEX IX_AlertSendLog_Channel_SentAt ON dbo.AlertSendLog (Channel, SentAt);
GO
