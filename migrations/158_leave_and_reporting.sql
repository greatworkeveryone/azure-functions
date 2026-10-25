-- Leave approvals and configurable reporting; no payroll or money authority changes.
IF OBJECT_ID('dbo.StaffReporting','U') IS NULL
BEGIN
 CREATE TABLE dbo.StaffReporting (Id INT NOT NULL PRIMARY KEY CHECK(Id=1), LinksJson NVARCHAR(MAX) NOT NULL CHECK(ISJSON(LinksJson)=1), Revision INT NOT NULL, UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedBy NVARCHAR(160) NOT NULL);
 INSERT dbo.StaffReporting(Id,LinksJson,Revision,UpdatedBy) VALUES(1,'[]',0,'Initial defaults');
END;
IF OBJECT_ID('dbo.LeaveRequests','U') IS NULL
BEGIN
 CREATE TABLE dbo.LeaveRequests (
  RequestId INT IDENTITY(1,1) PRIMARY KEY, UserId INT NOT NULL REFERENCES dbo.AppUsers(UserID),
  Kind NVARCHAR(30) NOT NULL, StartDate DATE NOT NULL, EndDate DATE NOT NULL, Hours DECIMAL(9,2) NOT NULL,
  Note NVARCHAR(500) NOT NULL DEFAULT '', Status NVARCHAR(20) NOT NULL DEFAULT 'pending', Revision INT NOT NULL DEFAULT 1,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  DecidedBy NVARCHAR(160) NULL, DecisionNote NVARCHAR(500) NULL,
  CONSTRAINT CK_LeaveRequests_Dates CHECK(EndDate>=StartDate),
  CONSTRAINT CK_LeaveRequests_Hours CHECK(Hours>0),
  CONSTRAINT CK_LeaveRequests_Status CHECK(Status IN ('pending','approved','declined','withdrawn'))
 );
 CREATE INDEX IX_LeaveRequests_User ON dbo.LeaveRequests(UserId,RequestId);
 CREATE INDEX IX_LeaveRequests_Status ON dbo.LeaveRequests(Status,RequestId);
END;
IF OBJECT_ID('dbo.PeopleWorkflowAudit','U') IS NULL
BEGIN
 CREATE TABLE dbo.PeopleWorkflowAudit (AuditId BIGINT IDENTITY(1,1) PRIMARY KEY, Subject NVARCHAR(40) NOT NULL, SubjectId INT NOT NULL, Action NVARCHAR(30) NOT NULL, BeforeJson NVARCHAR(MAX) NULL, AfterJson NVARCHAR(MAX) NOT NULL, ActorOid NVARCHAR(255) NOT NULL, ActorName NVARCHAR(160) NOT NULL, CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());
END;
