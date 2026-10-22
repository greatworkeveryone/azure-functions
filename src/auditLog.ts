import { AppRole } from "./auth";
import { canReadEvent, type EventAudience } from "./majorEvents";
export const AUDIT_READ_ROLES = [AppRole.FACILITIES_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] as const;
export const AUDIT_AREAS = [
  "facilities",
  "documents",
  "inspections",
  "events",
  "people",
  "administration",
  "finance",
] as const;
// A positive list: a new or unclassified ledger action is never exposed to Facilities.
export const OPERATIONAL_AUDIT_ACTIONS = [
  "job.reopen",
  "job.defects_override",
  "service_schedule.archive",
  "service_schedule.create",
  "service_schedule.mark_serviced",
  "service_schedule.restore",
  "service_schedule.skip_due",
  "service_schedule.update",
] as const;
export const EVENT_AUDIENCES: readonly EventAudience[] = [
  "managers",
  "accounts_managers",
  "accounts_team",
  "operational_staff",
];
// Same predicate as the event screens use, so audit metadata never outlives an event's Audience.
export function readableOperationalAudiences(roles: readonly string[]): EventAudience[] {
  return EVENT_AUDIENCES.filter((audience) => canReadEvent(roles, "operational", audience));
}
export function fullAuditAccess(roles: readonly string[]): boolean {
  return roles.some((role) => ["admin", "cfo", "director"].includes(role));
}
// Only audit metadata is selected. Snapshots, reasons, free-text bodies, tokens,
// lease terms, payroll details and financial amounts never enter this projection.
export const AUDIT_UNION_SQL = `
 SELECT CONCAT('ledger:',l.LedgerId) AS AuditKey,l.OccurredAt,l.ActorName,
 l.Action,CASE WHEN l.Action IN (SELECT [value] FROM OPENJSON(@OperationalActions)) AND l.TenantId IS NULL AND l.FinancialImpact IS NULL THEN 'facilities' WHEN l.Action LIKE 'job.%' AND l.TenantId IS NULL AND l.FinancialImpact IS NULL THEN 'facilities' WHEN l.Action LIKE 'user.%' OR l.Action LIKE 'access.%' THEN 'administration' ELSE 'finance' END AS Area,
 l.SubjectType,CONVERT(NVARCHAR(128),l.SubjectId) AS SubjectId,l.BuildingId,
 CASE WHEN @Full=1 THEN l.JobId ELSE NULL END AS JobId
 FROM dbo.DecisionLedger l
 WHERE (@Full=1 OR (l.Action IN (SELECT [value] FROM OPENJSON(@OperationalActions)) AND l.TenantId IS NULL AND l.FinancialImpact IS NULL))
 AND ((l.JobId IS NULL OR l.JobId IN(SELECT JobID FROM dbo.Jobs WHERE IsTest=0)) AND (l.TenantId IS NULL OR l.TenantId IN(SELECT TenantId FROM dbo.Tenants WHERE IsTest=0)) OR @ShowTest=1)
 UNION ALL
 SELECT CONCAT('building:',AuditId),CreatedAt,ActorName,'building.details_changed','facilities','building',CONVERT(NVARCHAR(128),BuildingId),BuildingId,NULL FROM dbo.BuildingRegisterAudit
 UNION ALL
 SELECT CONCAT('maintenance:',AuditId),CreatedAt,ActorName,'maintenance.coverage_changed','facilities','building',CONVERT(NVARCHAR(128),BuildingId),BuildingId,NULL FROM dbo.MaintenanceCoverageAudit
 UNION ALL
 SELECT CONCAT('contractor:',AuditId),CreatedAt,ActorName,'contractor.coverage_changed','facilities','contractor',CONVERT(NVARCHAR(128),ContractorId),NULL,NULL FROM dbo.ContractorCoverageAudit
 UNION ALL
 SELECT CONCAT('document:',a.AuditId),a.CreatedAt,a.ActorName,CONCAT('document.',a.Action),'documents','document',CONVERT(NVARCHAR(128),a.DocumentId),d.BuildingId,NULL FROM dbo.RegisterDocumentAudit a JOIN dbo.RegisterDocuments d ON d.DocumentId=a.DocumentId
 WHERE @Full=1 OR (d.TenantId IS NULL AND d.Kind IN ('certificate','plan','manual') AND d.ServiceCategory IN ('Mechanical / air conditioning','Fire / life safety','Evacuation','Telecommunications','Plumbing / hydraulic','Electrical','Building / structural','Environmental','Insurance'))
 UNION ALL
 SELECT CONCAT('procedure:',a.AuditId),a.ChangedAt,a.ChangedBy,'procedure.authority_changed','documents','procedure',a.Slug,NULL,NULL FROM dbo.ProcedureEndorsementAudit a WHERE @Full=1
 UNION ALL
 SELECT CONCAT('people:',AuditId),CreatedAt,ActorName,CONCAT(Subject,'.',Action),'people',Subject,CONVERT(NVARCHAR(128),SubjectId),NULL,NULL FROM dbo.PeopleWorkflowAudit WHERE @Full=1
 UNION ALL
 SELECT CONCAT('inspection:',o.OpId),o.AppliedAt,'Not recorded',CONCAT('inspection.',o.OpType),'inspections','inspection',CONVERT(NVARCHAR(128),o.InspectionId),i.BuildingId,NULL FROM dbo.InspectionOperationLog o JOIN dbo.Inspections i ON i.Id=o.InspectionId
 UNION ALL
 SELECT CONCAT('event:',a.EntryId),a.CreatedAt,a.ActorName,CONCAT('event.',a.EntryType),'events','event',CONVERT(NVARCHAR(128),a.EventId),a.BuildingId,NULL FROM dbo.MajorEventEntries a JOIN dbo.MajorEvents e ON e.EventId=a.EventId WHERE @Full=1 OR (e.Domain='operational' AND e.Audience IN (SELECT [value] FROM OPENJSON(@EventAudiences)))
 UNION ALL
 SELECT CONCAT('key:',a.Id),a.CheckedOutAt,a.CheckedOutBy,'key.checked_out','facilities','key_checkout',CONVERT(NVARCHAR(128),a.Id),NULL,NULL FROM dbo.KeyCheckoutBatches a
`;
export const AUDIT_COLUMNS =
  "AuditKey,OccurredAt,ActorName,Action,Area,SubjectType,SubjectId,BuildingId,JobId";
