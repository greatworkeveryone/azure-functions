// GET /api/resolveReference?ref=…
//
// Finds records for a reference typed or pasted by staff. Johanne's
// pre-Floorplan MYOB references (66Sm261013, McMgm26q3, ALLins26a) are not
// stored anywhere in Floorplan, so they are decoded rather than looked up:
//   1. exact match on a PO number, invoice number, supplier invoice number
//      or quote number;
//   2. only if none, parseReference, then per decomposition the building's
//      POs for that charge code and its jobs inside the period.
// Everything is read-only and capped at 50 rows.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery, SqlRow } from "../db";
import { parseReference, periodToUtcRange, type ParsedReference } from "../reference-codes";
import { validateSearchQuery } from "../searchUtils";
import { jobPath } from "../jobLinks";

export const RESOLVE_REFERENCE_CAP = 50;

// Mirror of VIEW_JOBS_ROLES in jobs.ts: whoever can read jobs can resolve a
// reference to them. resolveReference.test.ts checks the two stay equal.
const RESOLVE_REFERENCE_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

export interface ExactMatch {
  type: "purchaseOrder" | "invoice" | "quote";
  id: number;
  jobId: number;
  number: string;
  matchedOn: "PONumber" | "InvoiceNumber" | "SupplierInvoiceNumber" | "QuoteNumber";
  href: string;
}

export interface DecodedMatch {
  type: "purchaseOrder" | "job";
  id: number;
  jobId: number;
  buildingId: number;
  label: string;
  createdAt: string | null;
  href: string;
}

const jobHref = (jobId: number) => jobPath(jobId);
// A money record opens its job at that record's step (J6).
const poHref = (jobId: number, poId: number) => jobPath(jobId, { poId, step: "po" });
const invoiceHref = (jobId: number, invoiceId: number) => jobPath(jobId, { invoiceId, step: "invoices" });
const quoteHref = (jobId: number, quoteId: number) => jobPath(jobId, { quoteId, step: "quotes" });
const capParam = { name: "Cap", type: TYPES.Int, value: RESOLVE_REFERENCE_CAP };

async function findExact(connection: Connection, ref: string): Promise<ExactMatch[]> {
  const refParam = { name: "Ref", type: TYPES.NVarChar, value: ref };
  const matches: ExactMatch[] = [];

  const pos = await executeQuery(
    connection,
    `SELECT TOP (@Cap) PurchaseOrderID, JobID, PONumber
       FROM PurchaseOrders WHERE PONumber = @Ref ORDER BY PurchaseOrderID DESC`,
    [capParam, refParam],
  );
  for (const r of pos) {
    matches.push({
      type: "purchaseOrder",
      id: r.PurchaseOrderID as number,
      jobId: r.JobID as number,
      number: r.PONumber as string,
      matchedOn: "PONumber",
      href: poHref(r.JobID as number, r.PurchaseOrderID as number),
    });
  }

  const invoices = await executeQuery(
    connection,
    `SELECT TOP (@Cap) JobInvoiceID, JobID, InvoiceNumber, SupplierInvoiceNumber
       FROM JobInvoices
      WHERE InvoiceNumber = @Ref OR SupplierInvoiceNumber = @Ref
      ORDER BY JobInvoiceID DESC`,
    [capParam, refParam],
  );
  for (const r of invoices) {
    const supplier = (r.SupplierInvoiceNumber as string | null) ?? null;
    const bySupplier = supplier !== null && supplier.toLowerCase() === ref.toLowerCase();
    matches.push({
      type: "invoice",
      id: r.JobInvoiceID as number,
      jobId: r.JobID as number,
      number: (bySupplier ? supplier : (r.InvoiceNumber as string)) as string,
      matchedOn: bySupplier ? "SupplierInvoiceNumber" : "InvoiceNumber",
      href: invoiceHref(r.JobID as number, r.JobInvoiceID as number),
    });
  }

  const quotes = await executeQuery(
    connection,
    `SELECT TOP (@Cap) QuoteID, JobID, QuoteNumber
       FROM Quotes WHERE QuoteNumber = @Ref ORDER BY QuoteID DESC`,
    [capParam, refParam],
  );
  for (const r of quotes) {
    matches.push({
      type: "quote",
      id: r.QuoteID as number,
      jobId: r.JobID as number,
      number: r.QuoteNumber as string,
      matchedOn: "QuoteNumber",
      href: quoteHref(r.JobID as number, r.QuoteID as number),
    });
  }
  return matches;
}

/** Reference codes that exist only in the database, so new buildings decode. */
async function loadDbBuildingCodes(connection: Connection): Promise<Record<string, string>> {
  const rows = await executeQuery(
    connection,
    "SELECT ReferenceCode, BuildingName FROM Buildings WHERE ReferenceCode IS NOT NULL",
  );
  const codes: Record<string, string> = {};
  for (const r of rows) codes[r.ReferenceCode as string] = (r.BuildingName as string | null) ?? (r.ReferenceCode as string);
  return codes;
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);

async function findDecoded(connection: Connection, decomposition: ParsedReference): Promise<DecodedMatch[]> {
  // ALL, OE, vehicles and vendors are not Buildings rows: nothing to find.
  const buildings = await executeQuery(
    connection,
    "SELECT BuildingID FROM Buildings WHERE ReferenceCode = @Code",
    [{ name: "Code", type: TYPES.NVarChar, value: decomposition.buildingCode }],
  );
  const { from, toExclusive } = periodToUtcRange(decomposition.period);
  const range = [
    { name: "From", type: TYPES.DateTime2, value: from },
    { name: "To", type: TYPES.DateTime2, value: toExclusive },
  ];

  const matches: DecodedMatch[] = [];
  for (const building of buildings as SqlRow[]) {
    const buildingId = building.BuildingID as number;
    const buildingParam = { name: "BuildingID", type: TYPES.Int, value: buildingId };

    const pos: SqlRow[] = await executeQuery(
      connection,
      `SELECT TOP (@Cap) po.PurchaseOrderID, po.JobID, po.PONumber, po.CreatedAt
         FROM PurchaseOrders po
         JOIN Jobs j ON j.JobID = po.JobID
        WHERE j.BuildingID = @BuildingID AND po.ChargeCode = @ChargeCode
          AND po.CreatedAt >= @From AND po.CreatedAt < @To
        ORDER BY po.CreatedAt DESC`,
      [capParam, buildingParam, { name: "ChargeCode", type: TYPES.NVarChar, value: decomposition.chargeCode }, ...range],
    );
    for (const r of pos) {
      matches.push({
        type: "purchaseOrder",
        id: r.PurchaseOrderID as number,
        jobId: r.JobID as number,
        buildingId,
        label: (r.PONumber as string | null) ?? `PO #${r.PurchaseOrderID}`,
        createdAt: iso(r.CreatedAt),
        href: poHref(r.JobID as number, r.PurchaseOrderID as number),
      });
    }

    const jobs: SqlRow[] = await executeQuery(
      connection,
      `SELECT TOP (@Cap) JobID, Title, CreatedAt
         FROM Jobs
        WHERE BuildingID = @BuildingID AND CreatedAt >= @From AND CreatedAt < @To
        ORDER BY CreatedAt DESC`,
      [capParam, buildingParam, ...range],
    );
    for (const r of jobs) {
      matches.push({
        type: "job",
        id: r.JobID as number,
        jobId: r.JobID as number,
        buildingId,
        label: (r.Title as string | null) ?? `Job #${r.JobID}`,
        createdAt: iso(r.CreatedAt),
        href: jobHref(r.JobID as number),
      });
    }
  }
  return matches;
}

export async function resolveReference(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, RESOLVE_REFERENCE_ROLES);
  if (denied) return denied;

  const validated = validateSearchQuery(request.query.get("ref") ?? undefined);
  if (!validated.ok) {
    return {
      status: 400,
      jsonBody: { error: validated.reason === "empty" ? "ref is required" : "ref must be 1–100 chars" },
    };
  }
  const ref = validated.value;

  let connection;
  try {
    connection = await createRequestConnection(token);

    const allExact = await findExact(connection, ref);
    if (allExact.length > 0) {
      const exact = allExact.slice(0, RESOLVE_REFERENCE_CAP);
      return {
        status: 200,
        jsonBody: { exact, decoded: [], truncated: allExact.length > RESOLVE_REFERENCE_CAP },
      };
    }

    const decompositions = parseReference(ref, await loadDbBuildingCodes(connection));
    let budget = RESOLVE_REFERENCE_CAP;
    let truncated = false;
    const decoded: { decomposition: ParsedReference; matches: DecodedMatch[] }[] = [];
    for (const decomposition of decompositions) {
      const found = await findDecoded(connection, decomposition);
      const matches = found.slice(0, budget);
      if (matches.length < found.length) truncated = true;
      budget -= matches.length;
      decoded.push({ decomposition, matches });
    }
    return { status: 200, jsonBody: { exact: [], decoded, truncated } };
  } catch (error: unknown) {
    context.error("resolveReference failed:", error instanceof Error ? error.message : error);
    return errorResponse("Failed to resolve reference", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("resolveReference", { methods: ["GET"], authLevel: "anonymous", handler: resolveReference });
