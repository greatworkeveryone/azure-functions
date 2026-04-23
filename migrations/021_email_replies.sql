-- Migration 021: EmailReplies — outbound replies sent via the email client.
--
-- GraphSent / GraphMessageID track whether the send was dispatched through
-- Microsoft Graph (sendMail). GraphError is retained for audit when the
-- Graph call fails (e.g. credentials not yet configured). In that case the
-- reply is still stored here so users can see and resend later.
--
-- Fully idempotent.

IF NOT EXISTS (
  SELECT 1 FROM sys.objects
  WHERE object_id = OBJECT_ID('dbo.EmailReplies') AND type = 'U'
)
BEGIN
  CREATE TABLE dbo.EmailReplies (
    ReplyID        INT            IDENTITY(1,1) PRIMARY KEY,
    EmailID        INT            NOT NULL,
    Body           NVARCHAR(MAX)  NOT NULL,
    ToAddress      NVARCHAR(512)  NULL,
    SentBy         NVARCHAR(255)  NULL,
    SentAt         DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    GraphMessageID NVARCHAR(512)  NULL,
    GraphSent      BIT            NOT NULL DEFAULT 0,
    GraphError     NVARCHAR(MAX)  NULL,

    CONSTRAINT FK_EmailReplies_Emails
      FOREIGN KEY (EmailID) REFERENCES dbo.Emails(EmailID)
  );

  CREATE INDEX IX_EmailReplies_EmailID
    ON dbo.EmailReplies(EmailID);
END;
GO
