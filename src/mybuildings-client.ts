// myBuildings API Client
// Covers: Buildings, Work Requests, Invoices, Contractors, Attachments, Bulk Status Update

import { assertMayLeave, type EgressSubject } from "./test-data";
import { MyBuildingsSwitchedOffError, mayPullWorkRequests, mayPushWorkRequests } from "./config/mybuildingsSwitches";

const API_URL = process.env.MYBUILDINGS_API_URL!;
const BEARER_TOKEN = process.env.MYBUILDINGS_BEARER_TOKEN!;
const PAGE_SIZE = 300;

// ── Shared fetch helper ───────────────────────────────────────────────────────

async function apiFetch(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<any> {
  // TR6 backstop: whatever a handler forgets to check, the work-request API is
  // never called while the switches say it must not be (config/mybuildingsSwitches.ts).
  if (/\/workrequests?\//i.test(path)) {
    if (!mayPullWorkRequests()) throw new MyBuildingsSwitchedOffError("pull");
    if (method !== "GET" && !mayPushWorkRequests()) throw new MyBuildingsSwitchedOffError("push");
  }
  const url = `${API_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      "cache-control": "no-cache",
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `myBuildings API error ${response.status}: ${response.statusText} - ${text}`,
    );
  }
  return response.json();
}

async function fetchAllPaged<T>(
  basePath: string,
  params: string = "",
  arrayKey: string,
): Promise<T[]> {
  const allItems: T[] = [];
  let skip = 0;
  let hasMore = true;
  while (hasMore) {
    const queryString = params
      ? `${basePath}?${params}&skip=${skip}`
      : `${basePath}?skip=${skip}`;

    const data = await apiFetch(queryString);

    // Response envelope: { Success, Data: { [arrayKey]: [...] }, RecordsReturned }
    const items: T[] = data.Data?.[arrayKey] ?? data[arrayKey] ?? [];
    if (Array.isArray(items) && items.length > 0) {
      allItems.push(...items);
      hasMore = items.length >= PAGE_SIZE;
      skip += PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }
  return allItems;
}

// ── Buildings ─────────────────────────────────────────────────────────────────

export interface MyBuilding {
  BuildingID?: number;
  BuildingName?: string;
  BuildingCode?: string;
  BuildingAddress?: string;
  ThirdPartySystem_BuildingID?: string;
  Region?: string;
  RegionID?: number;
  NLA?: string;
  InvoicingAddress?: string;
  ContactPhoneNumber?: string;
  Active?: boolean;
  Levels?: string[];
  LastModifiedDate?: string;
}

export async function fetchAllBuildings(): Promise<MyBuilding[]> {
  return fetchAllPaged<MyBuilding>("/core/api/buildings/v1", "", "Buildings");
}

export async function fetchBuildingById(
  buildingId: number,
): Promise<MyBuilding | null> {
  const data = await apiFetch(`/core/api/buildings/v1?buildingID=${encodeURIComponent(String(buildingId))}`);
  const buildings: MyBuilding[] = data.Data?.Buildings ?? data.Buildings ?? [];
  return buildings.length > 0 ? buildings[0] : null;
}

// ── Work Requests ─────────────────────────────────────────────────────────────

export interface MyWorkRequest {
  WorkRequestID?: number;
  JobCode?: string;
  BuildingID?: number;
  BuildingName?: string;
  BuildingAddress?: string;
  ThirdPartySystem_BuildingID?: string;
  LevelName?: string;
  TenantName?: string;
  Category?: string;
  Type?: string;
  SubType?: string;
  StatusID?: number;
  Status?: string;
  Priority?: string;
  Details?: string;
  ExactLocation?: string;
  ContactName?: string;
  ContactPhone?: string;
  ContactEmail?: string;
  AssignedTo?: string;
  TotalCost?: number;
  CostNotToExceed?: number;
  WorkBeganDate?: string;
  ExpectedCompletionDate?: string;
  ActualCompletionDate?: string;
  LastModifiedDate?: string;
  WorkNotes?: string;
  WorkNotesHiddenFromTenant?: string;
  LoggedInAs?: string;
  PersonAffected?: string;
}

export async function fetchWorkRequests(
  params: string = "",
): Promise<MyWorkRequest[]> {
  return fetchAllPaged<MyWorkRequest>(
    "/core/api/workrequests/v1",
    params,
    "WorkRequests",
  );
}

export async function fetchWorkRequestById(
  workRequestId: number,
): Promise<MyWorkRequest | null> {
  const data = await apiFetch(`/core/api/workrequests/v1/${encodeURIComponent(String(workRequestId))}`);
  const wrs: MyWorkRequest[] = data.Data?.WorkRequests ?? data.WorkRequests ?? [];
  return wrs.length > 0 ? wrs[0] : null;
}

export interface CreateWorkRequestPayload {
  BuildingName?: string;
  BuildingID?: string | number;
  LevelName?: string;
  ContactName?: string;
  ContactPhone?: string;
  ContactEmail?: string;
  Category?: string;
  CategoryID?: string | number;
  Type?: string;
  TypeID?: string | number;
  SubType?: string;
  SubTypeId?: string | number;
  TenantName?: string;
  ThirdPartySystem_TenantID?: string;
  ExactLocation?: string;
  PersonAffected?: string;
  Details?: string;
  Priority?: string;
  PriorityID?: string | number;
  AssignedToUserID?: string | number;
  ApplyToAssetIDs?: number[];
}

export async function createWorkRequest(
  payload: CreateWorkRequestPayload,
): Promise<unknown> {
  return apiFetch("/core/api/workrequest/v1/create", "POST", payload);
}

// ── Work Request Attachments: read side (TR6 import) ──────────────────────────
// The upload endpoint below is documented; the list/download side is not in
// the contract we hold. The path is isolated here so the first real read-only
// run against the API can correct it in one place. The import treats a failure
// as "attachments unavailable" and flags the request, it never guesses.

export interface MyAttachmentRef {
  AttachmentID?: number | string;
  Attachment_Name?: string;
  Attachment_URL?: string;
  Attachment_Extension?: string;
  ContentType?: string;
}

export async function fetchWorkRequestAttachments(workRequestId: number): Promise<MyAttachmentRef[]> {
  const data = await apiFetch(`/core/api/workrequest/v1/attachments?workRequestID=${encodeURIComponent(String(workRequestId))}`);
  return data.Data?.Attachments ?? data.Attachments ?? [];
}

/** Downloads a file the API named. Only https URLs on the configured API host. */
export async function downloadAttachmentBytes(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  if (!mayPullWorkRequests()) throw new MyBuildingsSwitchedOffError("pull");
  const target = new URL(url);
  const api = new URL(API_URL);
  if (target.protocol !== "https:" || target.host !== api.host) {
    throw new Error(`Refusing to download from ${target.host}: not the myBuildings API host`);
  }
  const response = await fetch(target.toString(), { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } });
  if (!response.ok) throw new Error(`myBuildings attachment download failed: ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
}

// ── Bulk Status Update ────────────────────────────────────────────────────────

export interface BulkStatusUpdatePayload1 {
  NewStatusID: number;
  Comment: string;
  WorkRequestIds: number[];
  FailureMessage?: string;
}

export interface BulkStatusUpdatePayload2Item {
  WorkRequestID: number;
  NewStatusID?: number;
  Comment?: string;
  TotalCost?: number;
}

export async function bulkStatusUpdate(
  payload: BulkStatusUpdatePayload1 | BulkStatusUpdatePayload2Item[],
): Promise<void> {
  await apiFetch("/core/api/workrequest/v1/bulkstatusupdate", "POST", payload);
}

// ── Work Request Attachments ──────────────────────────────────────────────────

export interface AttachmentPayload {
  JobCode?: string;
  WorkRequestID?: number;
  Attachment_Name: string;
  Attachment_URL: string;
  Attachment_Extension?: string;
}

/** `egress` is what the file is about; a test job's file is refused (D9). */
export async function uploadAttachment(
  egress: EgressSubject,
  payload: AttachmentPayload,
): Promise<void> {
  assertMayLeave("mybuildings", egress);
  await apiFetch("/core/api/workrequest/v1/attachment", "POST", payload);
}

// ── Invoices ──────────────────────────────────────────────────────────────────

export interface MyInvoice {
  InvoiceID?: number;
  InvoiceNumber?: string;
  WorkRequestID?: number;
  JobCode?: string;
  BuildingName?: string;
  BuildingID?: number;
  ThirdPartySystem_BuildingID?: string;
  ContractorName?: string;
  ContractorID?: number;
  ThirdPartySystem_ContractorID?: string;
  InvoiceAmount?: number;
  GSTAmount?: number;
  TotalAmount?: number;
  InvoiceDate?: string;
  DateApproved?: string;
  StatusID?: number;
  Status?: string;
  Details?: string;
  InvoicePDFURL?: string;
  GLAccountCode?: string;
}

export async function fetchInvoices(params: string): Promise<MyInvoice[]> {
  const data = await apiFetch(`/core/api/invoices/v1?${params}`);
  return data.Data?.Invoices ?? data.Invoices ?? [];
}

// ── Contractors ───────────────────────────────────────────────────────────────

export interface MyContractor {
  ContractorID?: number;
  ThirdPartySystem_ContractorID?: string;
  ContractorName?: string;
  ContractorComments?: string;
  ContractorCategory?: string;
  ABN?: string;
  Active?: boolean;
  Suspended?: boolean;
  EmailAddress?: string;
  PhoneNumber?: string;
  MobileNumber?: string;
  ContactFirstName?: string;
  ContactLastName?: string;
  Contractor_SpareField1?: string;
  Contractor_SpareField2?: string;
  Contractor_SpareField3?: string;
  Contractor_SpareField4?: string;
}

export async function fetchAllContractors(): Promise<MyContractor[]> {
  return fetchAllPaged<MyContractor>(
    "/core/api/contractors/v1",
    "",
    "Contractors",
  );
}

export async function fetchContractorById(
  contractorId: number,
): Promise<MyContractor | null> {
  const data = await apiFetch(`/core/api/contractors/v1?contractorID=${encodeURIComponent(String(contractorId))}`);
  const contractors: MyContractor[] = data.Data?.Contractors ?? data.Contractors ?? [];
  return contractors.length > 0 ? contractors[0] : null;
}

export async function createOrUpdateContractors(
  contractors: MyContractor[],
): Promise<unknown> {
  return apiFetch("/core/api/contractors/v1", "PUT", {
    Contractors: contractors,
  });
}
