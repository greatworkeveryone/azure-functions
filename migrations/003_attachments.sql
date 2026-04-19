-- Attachments table — local record of files uploaded for a work request.
-- The actual file lives in Azure Blob Storage. A read-only SAS URL is what
-- we hand to myBuildings. MyBuildingsConfirmedAt lets us later delete blobs
-- once myBuildings has ingested the file.

CREATE TABLE dbo.Attachments (
    Id                      INT IDENTITY(1,1) PRIMARY KEY,
    WorkRequestID           INT            NOT NULL,
    JobCode                 NVARCHAR(100)  NULL,
    BlobName                NVARCHAR(400)  NOT NULL,
    OriginalName            NVARCHAR(400)  NOT NULL,
    Extension               NVARCHAR(20)   NULL,
    ContentType             NVARCHAR(200)  NULL,
    SizeBytes               BIGINT         NULL,
    UploadedBy              NVARCHAR(200)  NULL,
    UploadedAt              DATETIME2      NOT NULL CONSTRAINT DF_Attachments_UploadedAt DEFAULT SYSUTCDATETIME(),
    MyBuildingsConfirmedAt  DATETIME2      NULL
);

CREATE INDEX IX_Attachments_WorkRequestID ON dbo.Attachments(WorkRequestID);
