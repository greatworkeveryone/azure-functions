-- 189_certificate_intake.sql  (TR8, PLAN §15)
--
-- Contractors email their own certificates of currency; staff file them from Incoming in one click.
--
--   dbo.EmailCertificateFilings   one row per certificate filed from an Incoming email (insert only, except that
--       AcknowledgementJobId is set once, when the optional reply is queued).
--       EmailId / AttachmentBlobName  the email and the attachment that was filed. Unique together, so one
--                                     attachment is filed once; the original email and its file are never touched.
--       DocumentId                    the register document (dbo.RegisterDocuments) the certificate became: the
--                                     register owns the evidence, this table only links to it. No foreign key to
--                                     the document's blob: the register is the storage layer.
--       ContractorId                  the contractor the certificate was filed against.
--       FiledByUserId / FiledByName   who filed it. AppUsers.UserID may be null for an unprovisioned caller.
--       AcknowledgementJobId          the comms job (dbo.Correspondence.CorrespondenceId) of the optional
--                                     "received, thanks" reply; null when none was sent. No foreign key: the
--                                     record outlives the correspondence.
--
--   dbo.Procedures / dbo.ProcedureVersions  the certificate_received email template, seeded once as a DRAFT
--       (insert only). A draft is never sent for real: it is used only while sends are off or a dry run.
--
-- Additive and re-runnable: every object behind an existence check.

IF OBJECT_ID(N'dbo.EmailCertificateFilings', N'U') IS NULL
  CREATE TABLE dbo.EmailCertificateFilings (
    FilingId             INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmailCertificateFilings PRIMARY KEY,
    EmailId              INT           NOT NULL,
    AttachmentBlobName   NVARCHAR(400) NOT NULL,
    DocumentId           INT           NOT NULL,
    ContractorId         INT           NOT NULL,
    FiledByUserId        INT           NULL,
    FiledByName          NVARCHAR(160) NOT NULL,
    FiledAt              DATETIME2     NOT NULL CONSTRAINT DF_EmailCertificateFilings_FiledAt DEFAULT SYSUTCDATETIME(),
    AcknowledgementJobId INT           NULL,
    CONSTRAINT UQ_EmailCertificateFilings_Attachment UNIQUE (EmailId, AttachmentBlobName),
    CONSTRAINT FK_EmailCertificateFilings_Email FOREIGN KEY (EmailId) REFERENCES dbo.Emails (EmailID),
    CONSTRAINT FK_EmailCertificateFilings_Document FOREIGN KEY (DocumentId) REFERENCES dbo.RegisterDocuments (DocumentId)
  );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_EmailCertificateFilings_Document' AND object_id = OBJECT_ID(N'dbo.EmailCertificateFilings'))
  CREATE INDEX IX_EmailCertificateFilings_Document ON dbo.EmailCertificateFilings (DocumentId);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = N'certificate-received')
  INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder, Owner)
  VALUES (N'certificate-received', N'Correspondence templates', N'facilities', 21, N'Facilities');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = N'certificate-received')
  INSERT INTO dbo.ProcedureVersions (Slug, VersionNo, Title, Summary, BlocksJson, Status, CreatedBy)
  VALUES (N'certificate-received', 1, N'We have received your certificate of currency',
    N'Sent, when a staff member chooses to, after a contractor''s certificate of currency has been filed from Incoming. Facilities approves the wording before it goes out.',
    N'[{"id": "certificate-received-0", "kind": "paragraph", "text": "Dear {{recipient.name}},"}, {"id": "certificate-received-1", "kind": "paragraph", "text": "Thank you for sending your certificate of currency. We have received it and added it to your record."}, {"id": "certificate-received-2", "kind": "paragraph", "text": "Please send us the renewed certificate before it expires. If anything about your cover changes, reply to this email."}]',
    N'draft', N'migration:189_certificate_intake');
GO
