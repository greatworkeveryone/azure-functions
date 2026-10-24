-- Contractor suggestions (SC-AI3): an append-only record of what was suggested,
-- with the exact feature values the ranker saw, and of what the person chose, so a
-- learned or LLM ranker can be trained and evaluated offline. Rows are only ever
-- inserted. Nothing here references Jobs, Buildings or Contractors by foreign key,
-- so the record outlives them. No existing table or row is touched.

IF OBJECT_ID('dbo.ContractorSuggestionSets', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ContractorSuggestionSets (
    SetId                INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_ContractorSuggestionSets PRIMARY KEY,
    CreatedAt            DATETIME2     NOT NULL CONSTRAINT DF_ContractorSuggestionSets_CreatedAt DEFAULT SYSUTCDATETIME(),
    ActorName            NVARCHAR(160) NOT NULL,
    ActorOid             NVARCHAR(64)  NOT NULL,
    JobId                INT           NULL,
    BuildingId           INT           NOT NULL,
    Trade                NVARCHAR(100) NULL,
    Context              VARCHAR(24)   NOT NULL,
    RankerVersion        NVARCHAR(64)  NOT NULL,
    FeatureSchemaVersion NVARCHAR(32)  NOT NULL,
    CandidateCount       INT           NOT NULL,
    IsTest               BIT           NOT NULL CONSTRAINT DF_ContractorSuggestionSets_IsTest DEFAULT 0,
    CONSTRAINT CK_ContractorSuggestionSets_Context CHECK (Context IN ('quote_request', 'assign'))
  );
END
GO

IF OBJECT_ID('dbo.ContractorSuggestionItems', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ContractorSuggestionItems (
    SetId        INT           NOT NULL CONSTRAINT FK_ContractorSuggestionItems_Set REFERENCES dbo.ContractorSuggestionSets (SetId),
    ContractorId INT           NOT NULL,
    [Rank]       INT           NOT NULL,
    Score        FLOAT         NOT NULL,
    FeaturesJson NVARCHAR(MAX) NOT NULL,
    ReasonsJson  NVARCHAR(MAX) NULL,
    CONSTRAINT PK_ContractorSuggestionItems PRIMARY KEY (SetId, ContractorId),
    CONSTRAINT CK_ContractorSuggestionItems_Rank CHECK ([Rank] >= 1),
    CONSTRAINT CK_ContractorSuggestionItems_Features CHECK (ISJSON(FeaturesJson) = 1),
    CONSTRAINT CK_ContractorSuggestionItems_Reasons CHECK (ReasonsJson IS NULL OR ISJSON(ReasonsJson) = 1)
  );
END
GO

-- ChosenRank is NULL when the chosen contractor was not among the suggestions; the
-- feature values for such a choice are captured when it is recorded.
IF OBJECT_ID('dbo.ContractorSuggestionOutcomes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ContractorSuggestionOutcomes (
    OutcomeId          INT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_ContractorSuggestionOutcomes PRIMARY KEY,
    SetId              INT           NOT NULL CONSTRAINT FK_ContractorSuggestionOutcomes_Set REFERENCES dbo.ContractorSuggestionSets (SetId),
    ChosenContractorId INT           NULL,
    ChosenRank         INT           NULL,
    Outcome            VARCHAR(20)   NOT NULL,
    ChosenFeaturesJson NVARCHAR(MAX) NULL,
    ActorName          NVARCHAR(160) NOT NULL,
    ActorOid           NVARCHAR(64)  NOT NULL,
    CreatedAt          DATETIME2     NOT NULL CONSTRAINT DF_ContractorSuggestionOutcomes_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ContractorSuggestionOutcomes_Outcome CHECK (Outcome IN ('chose_suggested', 'chose_other', 'dismissed')),
    CONSTRAINT CK_ContractorSuggestionOutcomes_Shape CHECK (
      (Outcome = 'dismissed'       AND ChosenContractorId IS NULL     AND ChosenRank IS NULL)
      OR (Outcome = 'chose_suggested' AND ChosenContractorId IS NOT NULL AND ChosenRank IS NOT NULL)
      OR (Outcome = 'chose_other'     AND ChosenContractorId IS NOT NULL AND ChosenRank IS NULL)
    ),
    CONSTRAINT CK_ContractorSuggestionOutcomes_Features CHECK (ChosenFeaturesJson IS NULL OR ISJSON(ChosenFeaturesJson) = 1)
  );
END
GO

-- The evaluation reads: sets by ranker version and date, a job's sets, a set's
-- items by rank, a contractor's appearances and choices, a set's outcomes.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContractorSuggestionSets_Version' AND object_id = OBJECT_ID('dbo.ContractorSuggestionSets'))
  CREATE INDEX IX_ContractorSuggestionSets_Version ON dbo.ContractorSuggestionSets (RankerVersion, FeatureSchemaVersion, CreatedAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContractorSuggestionSets_Job' AND object_id = OBJECT_ID('dbo.ContractorSuggestionSets'))
  CREATE INDEX IX_ContractorSuggestionSets_Job ON dbo.ContractorSuggestionSets (JobId, CreatedAt) WHERE JobId IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_ContractorSuggestionItems_SetRank' AND object_id = OBJECT_ID('dbo.ContractorSuggestionItems'))
  CREATE UNIQUE INDEX UX_ContractorSuggestionItems_SetRank ON dbo.ContractorSuggestionItems (SetId, [Rank]);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContractorSuggestionItems_Contractor' AND object_id = OBJECT_ID('dbo.ContractorSuggestionItems'))
  CREATE INDEX IX_ContractorSuggestionItems_Contractor ON dbo.ContractorSuggestionItems (ContractorId, SetId);
GO

-- One outcome per contractor per set (NULL counts as one value, so a set is dismissed at most once).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_ContractorSuggestionOutcomes_SetContractor' AND object_id = OBJECT_ID('dbo.ContractorSuggestionOutcomes'))
  CREATE UNIQUE INDEX UX_ContractorSuggestionOutcomes_SetContractor ON dbo.ContractorSuggestionOutcomes (SetId, ChosenContractorId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContractorSuggestionOutcomes_Contractor' AND object_id = OBJECT_ID('dbo.ContractorSuggestionOutcomes'))
  CREATE INDEX IX_ContractorSuggestionOutcomes_Contractor ON dbo.ContractorSuggestionOutcomes (ChosenContractorId, SetId);
GO

-- Append-only in the database as well as in the code (a guard test pins the code).
-- CREATE TRIGGER must be first in its batch, so it goes through EXEC as in 094 and 115.
IF OBJECT_ID('dbo.TR_ContractorSuggestionSets_AppendOnly', 'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_ContractorSuggestionSets_AppendOnly ON dbo.ContractorSuggestionSets INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''ContractorSuggestionSets is append-only'', 1; END;');
GO

IF OBJECT_ID('dbo.TR_ContractorSuggestionItems_AppendOnly', 'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_ContractorSuggestionItems_AppendOnly ON dbo.ContractorSuggestionItems INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''ContractorSuggestionItems is append-only'', 1; END;');
GO

IF OBJECT_ID('dbo.TR_ContractorSuggestionOutcomes_AppendOnly', 'TR') IS NULL
  EXEC(N'CREATE TRIGGER dbo.TR_ContractorSuggestionOutcomes_AppendOnly ON dbo.ContractorSuggestionOutcomes INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''ContractorSuggestionOutcomes is append-only'', 1; END;');
GO
