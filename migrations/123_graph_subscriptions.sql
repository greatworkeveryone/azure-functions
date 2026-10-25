-- 123_graph_subscriptions — the Graph mail subscription table (DL-13, beta sprint D7).
--
-- graphWebhook.ts has always read and written dbo.GraphSubscriptions, but no
-- migration created it: production never had one (setupGraphSubscription made
-- a Graph subscription and then failed to record it; renewGraphSubscription
-- failed every night), and dev's copy was made by hand. One row per mailbox:
--   SubscriptionID   Graph's id for the subscription
--   Mailbox          the mailbox it watches (unique)
--   Resource         users/<mailbox>/mailFolders/Inbox/messages
--   ExpiresAt        when Graph drops it (mail subscriptions last ~3 days)
--   ClientStateHash  SHA-256 of the client state it was created with; the
--                    secret itself is never stored
--   CreatedAt        when the row was first written
--
-- Additive and re-runnable. A hand-made copy gets the missing columns. If it
-- holds two rows for one mailbox the unique index can't be built: this stops
-- with an error instead of skipping it, so someone keeps the live row by hand.

IF OBJECT_ID(N'dbo.GraphSubscriptions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.GraphSubscriptions (
    SubscriptionID  NVARCHAR(100) NOT NULL CONSTRAINT PK_GraphSubscriptions PRIMARY KEY,
    Mailbox         NVARCHAR(320) NOT NULL,
    Resource        NVARCHAR(500) NULL,
    ExpiresAt       DATETIME2(3)  NOT NULL,
    ClientStateHash NVARCHAR(64)  NULL,
    CreatedAt       DATETIME2(3)  NOT NULL CONSTRAINT DF_GraphSubscriptions_CreatedAt DEFAULT SYSUTCDATETIME()
  );
END
GO

IF COL_LENGTH(N'dbo.GraphSubscriptions', N'Resource') IS NULL
  ALTER TABLE dbo.GraphSubscriptions ADD Resource NVARCHAR(500) NULL;
GO

IF COL_LENGTH(N'dbo.GraphSubscriptions', N'ClientStateHash') IS NULL
  ALTER TABLE dbo.GraphSubscriptions ADD ClientStateHash NVARCHAR(64) NULL;
GO

IF COL_LENGTH(N'dbo.GraphSubscriptions', N'CreatedAt') IS NULL
  ALTER TABLE dbo.GraphSubscriptions ADD CreatedAt DATETIME2(3) NOT NULL
    CONSTRAINT DF_GraphSubscriptions_CreatedAt DEFAULT SYSUTCDATETIME();
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = N'UX_GraphSubscriptions_Mailbox' AND object_id = OBJECT_ID(N'dbo.GraphSubscriptions')
)
BEGIN
  IF EXISTS (SELECT Mailbox FROM dbo.GraphSubscriptions GROUP BY Mailbox HAVING COUNT(*) > 1)
  BEGIN
    ;THROW 51123, N'GraphSubscriptions has more than one row for a mailbox. Keep the live subscription by hand, then apply 123 again.', 1;
  END;
  CREATE UNIQUE INDEX UX_GraphSubscriptions_Mailbox ON dbo.GraphSubscriptions (Mailbox);
END
