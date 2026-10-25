-- 176_inbound_triage (EB3): replies come home, and mail to notices@ is triaged.
--
--   dbo.Emails (nine new columns, all NULL, nothing backfilled or rewritten)
--     Mailbox           which mailbox the message was read from. Set on mail
--                       synced after this migration; older rows stay NULL
--                       (the one mailbox Incoming has always read).
--     InReplyTo         the Message-ID this email answers, from its In-Reply-To
--                       header, angle brackets off.
--     ReferenceIds      the ids in its References header, space separated.
--     LinkedSendKind / LinkedSendId / LinkedSendSubject / LinkedAt
--                       the stored send this email replies to (EB1's send core),
--                       found through InReplyTo / ReferenceIds.
--     AssignedToUserId / AssignedAt / AssignedBy / AssignmentReason
--                       who owns the email now, since when, who put them there
--                       (a person's name, or "Floorplan (automatic)") and the
--                       plain reasons shown beside the name.
--   Per-mailbox watermarks already exist: dbo.EmailSyncState (129) is keyed by
--   mailbox, so every extra mailbox gets its own row there. Nothing to add.
--
--   Append-only routing log, as 171 does for contractor suggestions. Rows are
--   only ever inserted; the tables refuse UPDATE and DELETE through triggers
--   and a guard test pins the code. Nothing references Emails, AppUsers or
--   anything else by foreign key, so the record outlives them.
--     dbo.EmailRoutingSets      one per triage of one email (or per manual
--                               assignment of an email triage never saw).
--     dbo.EmailRoutingItems     the candidates ranked, with the exact features.
--     dbo.EmailRoutingOutcomes  what happened: assigned automatically, accepted
--                               by a manager, someone else picked, reassigned.
--
-- Additive and re-runnable: every object behind an existence check, each ADD in
-- its own batch (a batch is compiled before it runs).

IF COL_LENGTH(N'dbo.Emails', N'Mailbox') IS NULL
  ALTER TABLE dbo.Emails ADD Mailbox NVARCHAR(320) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'InReplyTo') IS NULL
  ALTER TABLE dbo.Emails ADD InReplyTo NVARCHAR(500) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'ReferenceIds') IS NULL
  ALTER TABLE dbo.Emails ADD ReferenceIds NVARCHAR(2000) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'LinkedSendKind') IS NULL
  ALTER TABLE dbo.Emails ADD LinkedSendKind NVARCHAR(30) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'LinkedSendId') IS NULL
  ALTER TABLE dbo.Emails ADD LinkedSendId NVARCHAR(64) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'LinkedSendSubject') IS NULL
  ALTER TABLE dbo.Emails ADD LinkedSendSubject NVARCHAR(300) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'LinkedAt') IS NULL
  ALTER TABLE dbo.Emails ADD LinkedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'AssignedToUserId') IS NULL
  ALTER TABLE dbo.Emails ADD AssignedToUserId INT NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'AssignedAt') IS NULL
  ALTER TABLE dbo.Emails ADD AssignedAt DATETIME2 NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'AssignedBy') IS NULL
  ALTER TABLE dbo.Emails ADD AssignedBy NVARCHAR(160) NULL;
GO

IF COL_LENGTH(N'dbo.Emails', N'AssignmentReason') IS NULL
  ALTER TABLE dbo.Emails ADD AssignmentReason NVARCHAR(1000) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Emails_AssignedToUser')
  ALTER TABLE dbo.Emails ADD CONSTRAINT FK_Emails_AssignedToUser FOREIGN KEY (AssignedToUserId) REFERENCES dbo.AppUsers (UserID);
GO

-- "Mine" and the triage queue read by assignee; most rows have none.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Emails_AssignedToUser' AND object_id = OBJECT_ID(N'dbo.Emails'))
  EXEC(N'CREATE INDEX IX_Emails_AssignedToUser ON dbo.Emails (AssignedToUserId, ReceivedAt) WHERE AssignedToUserId IS NOT NULL');
GO

-- The triage batch looks mail up by mailbox and arrival.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Emails_Mailbox_ReceivedAt' AND object_id = OBJECT_ID(N'dbo.Emails'))
  EXEC(N'CREATE INDEX IX_Emails_Mailbox_ReceivedAt ON dbo.Emails (Mailbox, ReceivedAt) WHERE Mailbox IS NOT NULL');
GO

IF OBJECT_ID(N'dbo.EmailRoutingSets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EmailRoutingSets (
    SetId                INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmailRoutingSets PRIMARY KEY,
    CreatedAt            DATETIME2     NOT NULL CONSTRAINT DF_EmailRoutingSets_CreatedAt DEFAULT SYSUTCDATETIME(),
    EmailId              INT           NOT NULL,
    Mailbox              NVARCHAR(320) NULL,
    Decision             VARCHAR(10)   NOT NULL,
    RankerVersion        NVARCHAR(64)  NOT NULL,
    FeatureSchemaVersion NVARCHAR(32)  NOT NULL,
    Intent               VARCHAR(24)   NOT NULL,
    Category             NVARCHAR(100) NULL,
    Lane                 VARCHAR(10)   NOT NULL,
    Urgency              VARCHAR(10)   NULL,
    WorkSource           VARCHAR(10)   NOT NULL,
    LinkedSendId         NVARCHAR(64)  NULL,
    ContextJson          NVARCHAR(MAX) NOT NULL,
    CandidateCount       INT           NOT NULL,
    ActorName            NVARCHAR(160) NOT NULL,
    IsTest               BIT           NOT NULL CONSTRAINT DF_EmailRoutingSets_IsTest DEFAULT 0,
    CONSTRAINT CK_EmailRoutingSets_Decision CHECK (Decision IN ('auto', 'queued', 'manual')),
    CONSTRAINT CK_EmailRoutingSets_Lane CHECK (Lane IN ('facilities', 'accounts', 'both')),
    CONSTRAINT CK_EmailRoutingSets_WorkSource CHECK (WorkSource IN ('rules', 'toddler', 'ai')),
    CONSTRAINT CK_EmailRoutingSets_Context CHECK (ISJSON(ContextJson) = 1)
  );
END
GO

IF OBJECT_ID(N'dbo.EmailRoutingItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EmailRoutingItems (
    SetId           INT           NOT NULL CONSTRAINT FK_EmailRoutingItems_Set REFERENCES dbo.EmailRoutingSets (SetId),
    CandidateUserId INT           NOT NULL,
    [Rank]          INT           NOT NULL,
    Score           FLOAT         NOT NULL,
    FeaturesJson    NVARCHAR(MAX) NOT NULL,
    ReasonsJson     NVARCHAR(MAX) NULL,
    CONSTRAINT PK_EmailRoutingItems PRIMARY KEY (SetId, CandidateUserId),
    CONSTRAINT CK_EmailRoutingItems_Rank CHECK ([Rank] >= 1),
    CONSTRAINT CK_EmailRoutingItems_Features CHECK (ISJSON(FeaturesJson) = 1),
    CONSTRAINT CK_EmailRoutingItems_Reasons CHECK (ReasonsJson IS NULL OR ISJSON(ReasonsJson) = 1)
  );
END
GO

-- ChosenRank is NULL when the person chosen was not among the ranked candidates; their
-- features are captured when the outcome is recorded. ActorOid is NULL for the system.
IF OBJECT_ID(N'dbo.EmailRoutingOutcomes', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EmailRoutingOutcomes (
    OutcomeId          INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmailRoutingOutcomes PRIMARY KEY,
    SetId              INT           NOT NULL CONSTRAINT FK_EmailRoutingOutcomes_Set REFERENCES dbo.EmailRoutingSets (SetId),
    EmailId            INT           NOT NULL,
    Outcome            VARCHAR(16)   NOT NULL,
    ChosenUserId       INT           NOT NULL,
    ChosenRank         INT           NULL,
    PreviousUserId     INT           NULL,
    ChosenFeaturesJson NVARCHAR(MAX) NULL,
    ActorName          NVARCHAR(160) NOT NULL,
    ActorOid           NVARCHAR(64)  NULL,
    CreatedAt          DATETIME2     NOT NULL CONSTRAINT DF_EmailRoutingOutcomes_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_EmailRoutingOutcomes_Outcome CHECK (Outcome IN ('auto_assigned', 'accepted', 'chose_other', 'reassigned')),
    CONSTRAINT CK_EmailRoutingOutcomes_Shape CHECK (Outcome <> 'reassigned' OR PreviousUserId IS NOT NULL),
    CONSTRAINT CK_EmailRoutingOutcomes_Features CHECK (ChosenFeaturesJson IS NULL OR ISJSON(ChosenFeaturesJson) = 1)
  );
END
GO

-- The evaluation reads: sets by ranker version and date, an email's sets, a set's items by
-- rank, a person's appearances and choices, a set's and an email's outcomes.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingSets_Version' AND object_id = OBJECT_ID(N'dbo.EmailRoutingSets'))
  CREATE INDEX IX_EmailRoutingSets_Version ON dbo.EmailRoutingSets (RankerVersion, FeatureSchemaVersion, CreatedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingSets_Email' AND object_id = OBJECT_ID(N'dbo.EmailRoutingSets'))
  CREATE INDEX IX_EmailRoutingSets_Email ON dbo.EmailRoutingSets (EmailId, SetId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_EmailRoutingItems_SetRank' AND object_id = OBJECT_ID(N'dbo.EmailRoutingItems'))
  CREATE UNIQUE INDEX UX_EmailRoutingItems_SetRank ON dbo.EmailRoutingItems (SetId, [Rank]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingItems_User' AND object_id = OBJECT_ID(N'dbo.EmailRoutingItems'))
  CREATE INDEX IX_EmailRoutingItems_User ON dbo.EmailRoutingItems (CandidateUserId, SetId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingOutcomes_Set' AND object_id = OBJECT_ID(N'dbo.EmailRoutingOutcomes'))
  CREATE INDEX IX_EmailRoutingOutcomes_Set ON dbo.EmailRoutingOutcomes (SetId, OutcomeId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingOutcomes_Email' AND object_id = OBJECT_ID(N'dbo.EmailRoutingOutcomes'))
  CREATE INDEX IX_EmailRoutingOutcomes_Email ON dbo.EmailRoutingOutcomes (EmailId, OutcomeId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailRoutingOutcomes_User' AND object_id = OBJECT_ID(N'dbo.EmailRoutingOutcomes'))
  CREATE INDEX IX_EmailRoutingOutcomes_User ON dbo.EmailRoutingOutcomes (ChosenUserId, SetId);
GO

-- Append-only in the database as well as in the code (a guard test pins the code).
-- CREATE TRIGGER must be first in its batch, so it goes through EXEC as in 094, 115 and 171.
IF OBJECT_ID(N'dbo.TR_EmailRoutingSets_AppendOnly', N'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_EmailRoutingSets_AppendOnly ON dbo.EmailRoutingSets INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''EmailRoutingSets is append-only'', 1; END;');
GO

IF OBJECT_ID(N'dbo.TR_EmailRoutingItems_AppendOnly', N'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_EmailRoutingItems_AppendOnly ON dbo.EmailRoutingItems INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''EmailRoutingItems is append-only'', 1; END;');
GO

IF OBJECT_ID(N'dbo.TR_EmailRoutingOutcomes_AppendOnly', N'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_EmailRoutingOutcomes_AppendOnly ON dbo.EmailRoutingOutcomes INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''EmailRoutingOutcomes is append-only'', 1; END;');
GO
