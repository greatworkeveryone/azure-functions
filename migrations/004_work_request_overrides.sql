-- Work request local overrides — per-WR table of fields we want to edit
-- locally without letting the myBuildings sync overwrite them. Read-side
-- queries LEFT JOIN this and COALESCE(o.col, wr.col) per overlaid column so
-- the local value wins when present. DELETE a row here to "reset to myBuildings".

CREATE TABLE dbo.WorkRequestOverrides (
    WorkRequestID           INT            NOT NULL PRIMARY KEY,
    AssignedTo              NVARCHAR(200)  NULL,
    Category                NVARCHAR(200)  NULL,
    [Type]                  NVARCHAR(200)  NULL,
    SubType                 NVARCHAR(200)  NULL,
    Priority                NVARCHAR(50)   NULL,
    Details                 NVARCHAR(MAX)  NULL,
    LevelName               NVARCHAR(200)  NULL,
    TenantName              NVARCHAR(200)  NULL,
    ExactLocation           NVARCHAR(400)  NULL,
    PersonAffected          NVARCHAR(200)  NULL,
    ContactName             NVARCHAR(200)  NULL,
    ContactPhone            NVARCHAR(100)  NULL,
    ContactEmail            NVARCHAR(200)  NULL,
    ExpectedCompletionDate  NVARCHAR(100)  NULL,
    WorkNotes               NVARCHAR(MAX)  NULL,
    TotalCost               DECIMAL(18,2)  NULL,
    CostNotToExceed         DECIMAL(18,2)  NULL,
    UpdatedAt               DATETIME2      NOT NULL CONSTRAINT DF_WROverrides_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy               NVARCHAR(200)  NULL
);
