import { AppRole } from "./auth";
export const DOCUMENT_SERVICE_CATEGORIES = ['Mechanical / air conditioning','Fire / life safety','Evacuation','Telecommunications','Plumbing / hydraulic','Electrical','Building / structural','Environmental','Insurance','General'] as const;
export const DOCUMENT_KINDS = ['certificate','report','plan','manual','policy','other'] as const;
export const DOCUMENT_MANAGERS = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.CFO, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL] as const;
export interface RegisteredDocumentInput { title: string; kind: string; category: string; buildingId: number | null; tenantId: number | null; issuedOn: string | null; expiresOn: string | null; reviewDue: string | null; ownerName: string; notes: string }
function text(value: unknown, label: string, max: number, optional = false): string {
 if (optional && (value === null || value === undefined || value === '')) return '';
 if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} is required (maximum ${max} characters)`);
 return value.trim();
}
function date(value: unknown, label: string): string | null {
 if (value === undefined || value === null || value === '') return null;
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error(`${label} must be a valid calendar date`);
 return value;
}
export function parseDocumentInput(body: Record<string,unknown>): RegisteredDocumentInput {
 const id = (value: unknown, negative: boolean): number | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value === 0 || Math.abs(value) > 2147483647 || (!negative && value < 0)) throw new Error('Invalid building or tenancy');
  return value;
 };
 const kind = text(body.kind, 'Document type', 24);
 const category = text(body.category, 'Service category', 100);
 if (!(DOCUMENT_KINDS as readonly string[]).includes(kind) || !(DOCUMENT_SERVICE_CATEGORIES as readonly string[]).includes(category)) throw new Error('Choose a known document type and service category');
 const issuedOn = date(body.issuedOn,'Issue date'); const expiresOn = date(body.expiresOn,'Expiry'); const reviewDue = date(body.reviewDue,'Review date');
 if (issuedOn && expiresOn && expiresOn < issuedOn) throw new Error('Expiry cannot precede issue');
 const buildingId = id(body.buildingId,true), tenantId = id(body.tenantId,false);
 if (tenantId && !buildingId) throw new Error('Choose the tenancy building');
 return { title: text(body.title,'Title',200), kind, category, buildingId, tenantId, issuedOn, expiresOn, reviewDue, ownerName: text(body.ownerName,'Responsible person',160), notes: text(body.notes,'Notes',6000,true) };
}
export function documentDateStatus(expiresOn: string | null, reviewDue: string | null, today: string): 'expired'|'due'|'current'|'undated' {
 if (expiresOn && expiresOn < today) return 'expired';
 const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCDate(horizon.getUTCDate()+30);
 if ([expiresOn,reviewDue].some(value => value && value <= horizon.toISOString().slice(0,10))) return 'due';
 return expiresOn || reviewDue ? 'current' : 'undated';
}
