-- Migration 108: comms_core (EB1, PLAN §13): the send core for native email.
--
-- Floorplan sends from one shared mailbox (Randazzo Properties <notices@...>),
-- with the reply-to chosen per send from an admin-managed list of identities and a
-- standardised signature composed on the server. This adds what that needs:
--
--   CommsIdentities          the reply-to identities (a team or department mailbox),
--                            the roles allowed to send on their behalf, and the
--                            identity's role signature as structured fields (lines
--                            of text, a phone, an email: no free HTML). Archived,
--                            never deleted. Version is a ROWVERSION: an edit must
--                            send it back and a stale one is a 409 (rule 6).
--   UserSignatures           a person's job title and phone for their standard
--                            signature. Keyed to AppUsers; written by the person
--                            or an admin.
--   Correspondence           one row per send job (broadcast, letter or system):
--                            the subject, the markdown body, the sender, the
--                            resolved reply-to, the signature as composed when it
--                            was queued, who created it (from the token), and its
--                            status and counts.
--   CorrespondenceRecipients one row per recipient: merge values, status, the
--                            Graph message id and the internet message id (what a
--                            reply's In-Reply-To names), attempts and the last error
--                            CODE (never provider text).
--   CorrespondenceEvents     append-only: one row per status change, of a job or of
--                            a recipient's outcome. An INSTEAD OF trigger refuses
--                            UPDATE and DELETE, as migration 171 does.
--
-- Additive and re-runnable: every object sits behind IF OBJECT_ID / IF NOT EXISTS and
-- no existing table or row is touched. New columns are nullable or defaulted. Nothing
-- is dropped, narrowed, renamed or updated. CREATE TRIGGER must be first in its batch,
-- so it goes through EXEC as in 094, 115 and 171.
--
-- RUNBOOK: apply 108 before the build that serves the comms routes (listCommsIdentities
-- and the rest). With COMMS_SEND_ENABLED unset the queue timer touches nothing but its
-- own TimerRuns row. Dry-run on a restored copy of production first (rule 4).

IF OBJECT_ID('dbo.CommsIdentities', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommsIdentities (
    IdentityId     INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommsIdentities PRIMARY KEY,
    Address        NVARCHAR(320) NOT NULL,
    DisplayName    NVARCHAR(120) NOT NULL,
    TeamLabel      NVARCHAR(80)  NULL,
    AllowedRoles   NVARCHAR(400) NOT NULL,
    SignatureLines NVARCHAR(1000) NOT NULL CONSTRAINT DF_CommsIdentities_SignatureLines DEFAULT N'[]',
    SignaturePhone NVARCHAR(40)  NULL,
    SignatureEmail NVARCHAR(320) NULL,
    IsActive       BIT           NOT NULL CONSTRAINT DF_CommsIdentities_IsActive DEFAULT 1,
    Version        ROWVERSION,
    CreatedAt      DATETIME2     NOT NULL CONSTRAINT DF_CommsIdentities_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy      NVARCHAR(200) NOT NULL,
    UpdatedAt      DATETIME2     NULL,
    UpdatedBy      NVARCHAR(200) NULL,
    ArchivedAt     DATETIME2     NULL,
    ArchivedBy     NVARCHAR(200) NULL,
    CONSTRAINT CK_CommsIdentities_Roles CHECK (ISJSON(AllowedRoles) = 1),
    CONSTRAINT CK_CommsIdentities_Lines CHECK (ISJSON(SignatureLines) = 1)
  );
END
GO

-- One live identity per address (an archived one frees it).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_CommsIdentities_Address' AND object_id = OBJECT_ID('dbo.CommsIdentities'))
  CREATE UNIQUE INDEX UX_CommsIdentities_Address ON dbo.CommsIdentities (Address) WHERE ArchivedAt IS NULL;
GO

IF OBJECT_ID('dbo.UserSignatures', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.UserSignatures (
    UserId    INT           NOT NULL CONSTRAINT PK_UserSignatures PRIMARY KEY CONSTRAINT FK_UserSignatures_User REFERENCES dbo.AppUsers (UserID),
    JobTitle  NVARCHAR(80)  NULL,
    Phone     NVARCHAR(30)  NULL,
    Version   ROWVERSION,
    UpdatedAt DATETIME2     NOT NULL CONSTRAINT DF_UserSignatures_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy NVARCHAR(200) NOT NULL
  );
END
GO

IF OBJECT_ID('dbo.Correspondence', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Correspondence (
    CorrespondenceId  INT            IDENTITY(1,1) NOT NULL CONSTRAINT PK_Correspondence PRIMARY KEY,
    Kind              VARCHAR(12)    NOT NULL,
    Subject           NVARCHAR(300)  NOT NULL,
    BodyMarkdown      NVARCHAR(MAX)  NOT NULL,
    TemplateId        NVARCHAR(120)  NULL,
    TemplateVersion   INT            NULL,
    FromAddress       NVARCHAR(320)  NOT NULL,
    FromName          NVARCHAR(120)  NOT NULL,
    ReplyToIdentityId INT            NULL CONSTRAINT FK_Correspondence_Identity REFERENCES dbo.CommsIdentities (IdentityId),
    ReplyToAddress    NVARCHAR(320)  NOT NULL,
    ReplyToName       NVARCHAR(200)  NULL,
    SignatureMode     VARCHAR(8)     NOT NULL,
    SignatureJson     NVARCHAR(MAX)  NOT NULL,
    CreatedByOid      NVARCHAR(255)  NOT NULL,
    CreatedByName     NVARCHAR(200)  NOT NULL,
    CreatedByEmail    NVARCHAR(320)  NOT NULL,
    CreatedByRole     NVARCHAR(32)   NULL,
    Status            VARCHAR(20)    NOT NULL CONSTRAINT DF_Correspondence_Status DEFAULT 'draft',
    RequiresApproval  BIT            NOT NULL CONSTRAINT DF_Correspondence_RequiresApproval DEFAULT 0,
    RecipientCount    INT            NOT NULL CONSTRAINT DF_Correspondence_RecipientCount DEFAULT 0,
    SentCount         INT            NOT NULL CONSTRAINT DF_Correspondence_SentCount DEFAULT 0,
    FailedCount       INT            NOT NULL CONSTRAINT DF_Correspondence_FailedCount DEFAULT 0,
    BlockedCount      INT            NOT NULL CONSTRAINT DF_Correspondence_BlockedCount DEFAULT 0,
    ApprovedByOid     NVARCHAR(255)  NULL,
    ApprovedByName    NVARCHAR(200)  NULL,
    ApprovedAt        DATETIME2      NULL,
    CancelledByName   NVARCHAR(200)  NULL,
    CancelledAt       DATETIME2      NULL,
    QueuedAt          DATETIME2      NULL,
    CompletedAt       DATETIME2      NULL,
    Version           ROWVERSION,
    CreatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Correspondence_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2      NOT NULL CONSTRAINT DF_Correspondence_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Correspondence_Kind CHECK (Kind IN ('broadcast', 'letter', 'system')),
    CONSTRAINT CK_Correspondence_Mode CHECK (SignatureMode IN ('role', 'personal')),
    CONSTRAINT CK_Correspondence_Status CHECK (Status IN ('draft', 'awaiting_approval', 'queued', 'sending', 'sent', 'cancelled', 'failed')),
    CONSTRAINT CK_Correspondence_Signature CHECK (ISJSON(SignatureJson) = 1)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Correspondence_Status' AND object_id = OBJECT_ID('dbo.Correspondence'))
  CREATE INDEX IX_Correspondence_Status ON dbo.Correspondence (Status, QueuedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Correspondence_Creator' AND object_id = OBJECT_ID('dbo.Correspondence'))
  CREATE INDEX IX_Correspondence_Creator ON dbo.Correspondence (CreatedByOid, CreatedAt);
GO

IF OBJECT_ID('dbo.CorrespondenceRecipients', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.CorrespondenceRecipients (
    RecipientId       INT            IDENTITY(1,1) NOT NULL CONSTRAINT PK_CorrespondenceRecipients PRIMARY KEY,
    CorrespondenceId  INT            NOT NULL CONSTRAINT FK_CorrespondenceRecipients_Correspondence REFERENCES dbo.Correspondence (CorrespondenceId),
    Address           NVARCHAR(320)  NOT NULL,
    Name              NVARCHAR(200)  NULL,
    RecipientType     VARCHAR(12)    NOT NULL,
    RecipientRefId    NVARCHAR(64)   NULL,
    MergeValues       NVARCHAR(MAX)  NULL,
    Status            VARCHAR(12)    NOT NULL CONSTRAINT DF_CorrespondenceRecipients_Status DEFAULT 'queued',
    SentToAddress     NVARCHAR(320)  NULL,
    GraphMessageId    NVARCHAR(512)  NULL,
    InternetMessageId NVARCHAR(998)  NULL,
    Attempts          INT            NOT NULL CONSTRAINT DF_CorrespondenceRecipients_Attempts DEFAULT 0,
    LastAttemptAt     DATETIME2      NULL,
    NextAttemptAt     DATETIME2      NULL,
    LastErrorCode     VARCHAR(40)    NULL,
    Detail            NVARCHAR(500)  NULL,
    SentAt            DATETIME2      NULL,
    CreatedAt         DATETIME2      NOT NULL CONSTRAINT DF_CorrespondenceRecipients_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2      NOT NULL CONSTRAINT DF_CorrespondenceRecipients_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_CorrespondenceRecipients_Type CHECK (RecipientType IN ('tenancy', 'contractor', 'staff', 'manual')),
    CONSTRAINT CK_CorrespondenceRecipients_Status CHECK (Status IN ('queued', 'sending', 'sent', 'failed', 'blocked', 'would_send', 'cancelled')),
    CONSTRAINT CK_CorrespondenceRecipients_Values CHECK (MergeValues IS NULL OR ISJSON(MergeValues) = 1)
  );
END
GO

-- One message per address per job: a repeated address is the same recipient.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_CorrespondenceRecipients_Address' AND object_id = OBJECT_ID('dbo.CorrespondenceRecipients'))
  CREATE UNIQUE INDEX UX_CorrespondenceRecipients_Address ON dbo.CorrespondenceRecipients (CorrespondenceId, Address);
GO

-- The queue reads queued (and would-send) recipients, oldest first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CorrespondenceRecipients_Queue' AND object_id = OBJECT_ID('dbo.CorrespondenceRecipients'))
  CREATE INDEX IX_CorrespondenceRecipients_Queue ON dbo.CorrespondenceRecipients (Status, NextAttemptAt, RecipientId) INCLUDE (CorrespondenceId);
GO

-- A reply names the message it answers by its internet message id (In-Reply-To): the lookup EB3 needs.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CorrespondenceRecipients_InternetMessageId' AND object_id = OBJECT_ID('dbo.CorrespondenceRecipients'))
  CREATE INDEX IX_CorrespondenceRecipients_InternetMessageId ON dbo.CorrespondenceRecipients (InternetMessageId) WHERE InternetMessageId IS NOT NULL;
GO

IF OBJECT_ID('dbo.CorrespondenceEvents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.CorrespondenceEvents (
    EventId          BIGINT        IDENTITY(1,1) NOT NULL CONSTRAINT PK_CorrespondenceEvents PRIMARY KEY,
    CorrespondenceId INT           NOT NULL CONSTRAINT FK_CorrespondenceEvents_Correspondence REFERENCES dbo.Correspondence (CorrespondenceId),
    RecipientId      INT           NULL,
    EventType        VARCHAR(12)   NOT NULL,
    FromStatus       VARCHAR(20)   NULL,
    ToStatus         VARCHAR(20)   NOT NULL,
    ActorKind        VARCHAR(8)    NOT NULL,
    ActorName        NVARCHAR(200) NOT NULL,
    ActorOid         NVARCHAR(255) NULL,
    ErrorCode        VARCHAR(40)   NULL,
    Detail           NVARCHAR(500) NULL,
    CreatedAt        DATETIME2(3)  NOT NULL CONSTRAINT DF_CorrespondenceEvents_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_CorrespondenceEvents_Type CHECK (EventType IN ('job', 'recipient')),
    CONSTRAINT CK_CorrespondenceEvents_Actor CHECK (ActorKind IN ('user', 'system'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CorrespondenceEvents_Job' AND object_id = OBJECT_ID('dbo.CorrespondenceEvents'))
  CREATE INDEX IX_CorrespondenceEvents_Job ON dbo.CorrespondenceEvents (CorrespondenceId, EventId);
GO

-- Append-only in the database as well as in the code (a guard test pins the code).
IF OBJECT_ID('dbo.TR_CorrespondenceEvents_AppendOnly', 'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_CorrespondenceEvents_AppendOnly ON dbo.CorrespondenceEvents INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''CorrespondenceEvents is append-only'', 1; END;');
GO
