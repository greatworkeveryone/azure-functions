-- Migration 064: Vacancies table for WordPress listing management.

CREATE TABLE dbo.Vacancies (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  Title            NVARCHAR(255)  NOT NULL,
  Subtitle         NVARCHAR(255)  NULL,
  Address          NVARCHAR(500)  NULL,
  Description      NVARCHAR(MAX)  NULL,
  AdditionalDetails NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  Images           NVARCHAR(MAX)  NOT NULL DEFAULT '[]',
  Status           NVARCHAR(20)   NOT NULL DEFAULT 'draft',
  WordPressPostId  INT            NULL,
  WordPressSlug    NVARCHAR(500)  NULL,
  LastSyncedAt     DATETIME2      NULL,
  TenancyId        INT            NULL,
  CreatedAt        DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  UpdatedAt        DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  CONSTRAINT CK_Vacancies_Status CHECK (Status IN ('draft', 'published')),
  CONSTRAINT CK_Vacancies_AdditionalDetails CHECK (ISJSON(AdditionalDetails) = 1),
  CONSTRAINT CK_Vacancies_Images CHECK (ISJSON(Images) = 1)
);
GO
