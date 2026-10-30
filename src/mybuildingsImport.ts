// myBuildings -> Floorplan import (TR6). Pure orchestration over injected
// dependencies so it is tested with no network, blob store or database.
//
// Safety: it only inserts and updates. It deletes nothing locally and calls no
// myBuildings write endpoint. A dry run reads the list and the attachment
// listings and writes nothing at all (no rows, no files, no run record).
// Re-running is safe: requests de-duplicate on the myBuildings WorkRequestID
// (MERGE), attachments on (WorkRequestID, SourceKey).

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import { MAX_SIZE_BYTES, bytesMatchMediaType, isAllowedContentType, normaliseMediaType } from "./upload-constants";
import { resolveAll } from "./sync-helpers";
import type { MyAttachmentRef, MyWorkRequest } from "./mybuildings-client";

export const IMPORT_BATCH_SIZE = 50;
export const IMPORT_ACTOR = "myBuildings import";
const MAX_FLAGS_RETURNED = 200;

export interface ImportDeps {
  downloadAttachment: (url: string) => Promise<{ bytes: Buffer; contentType: string | null }>;
  fetchAttachments: (workRequestId: number) => Promise<MyAttachmentRef[]>;
  storeBlob: (bytes: Buffer, name: string, contentType: string, keyPrefix: string) => Promise<string>;
  upsertWorkRequest: (connection: Connection, wr: MyWorkRequest) => Promise<void>;
}

export interface ImportOptions {
  /** Most requests whose attachments are processed in this call; the rest stay pending for the next run. */
  attachmentLimit: number;
  dryRun: boolean;
  recheckAttachments: boolean;
  startedBy: string;
  since: string | null;
  buildingId: number | null;
}

export interface BuildingCounts {
  attachmentsFlagged: number;
  attachmentsImported: number;
  attachmentsSkipped: number;
  flagged: number;
  inserted: number;
  seen: number;
  unchanged: number;
  updated: number;
}

export interface ImportFlag {
  buildingName: string | null;
  kind: "building" | "id" | "attachment" | "attachment_listing";
  reason: string;
  workRequestId: number | null;
}

export interface ImportResult {
  attachmentsPending: number;
  byBuilding: Record<string, BuildingCounts>;
  dryRun: boolean;
  flagged: number;
  flags: ImportFlag[];
  runId: number | null;
  totals: BuildingCounts;
}

const empty = (): BuildingCounts => ({
  attachmentsFlagged: 0, attachmentsImported: 0, attachmentsSkipped: 0, flagged: 0, inserted: 0, seen: 0, unchanged: 0, updated: 0,
});

const MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", pdf: "application/pdf", png: "image/png", webp: "image/webp",
};

function sourceKeyOf(ref: MyAttachmentRef): string | null {
  const key = ref.AttachmentID ?? ref.Attachment_URL ?? ref.Attachment_Name;
  return key === undefined || key === null || String(key).trim() === "" ? null : String(key).slice(0, 400);
}

function nameOf(ref: MyAttachmentRef): string {
  const raw = (ref.Attachment_Name ?? "attachment").trim() || "attachment";
  const ext = (ref.Attachment_Extension ?? "").replace(/^\./, "");
  return ext && !raw.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${raw}.${ext}` : raw;
}

export async function runMyBuildingsImport(
  connection: Connection,
  workRequests: MyWorkRequest[],
  nameToId: Map<string, number>,
  deps: ImportDeps,
  options: ImportOptions,
  log: (message: string) => void = () => undefined,
): Promise<ImportResult> {
  const totals = empty();
  const byBuilding: Record<string, BuildingCounts> = {};
  const flags: ImportFlag[] = [];
  const counts = (name: string | null | undefined) => (byBuilding[name || "(no building)"] ??= empty());
  const flag = (f: ImportFlag, bucket: BuildingCounts, kind: "request" | "attachment") => {
    flags.push(f);
    bucket.flagged += kind === "request" ? 1 : 0;
    bucket.attachmentsFlagged += kind === "attachment" ? 1 : 0;
  };

  let runId: number | null = null;
  if (!options.dryRun) {
    const run = await executeQuery(
      connection,
      `INSERT INTO dbo.MyBuildingsImportRuns (StartedBy, Since, BuildingId) OUTPUT INSERTED.RunId VALUES (@StartedBy, @Since, @BuildingId)`,
      [
        { name: "StartedBy", type: TYPES.NVarChar, value: options.startedBy },
        { name: "Since", type: TYPES.NVarChar, value: options.since },
        { name: "BuildingId", type: TYPES.Int, value: options.buildingId },
      ],
    );
    runId = run[0].RunId as number;
  }

  const { resolved } = resolveAll(workRequests, { fallbackId: options.buildingId ?? undefined, nameToId });
  let attachmentBudget = options.attachmentLimit;
  let attachmentsPending = 0;

  for (let start = 0; start < resolved.length; start += IMPORT_BATCH_SIZE) {
    const batch = resolved.slice(start, start + IMPORT_BATCH_SIZE);
    const ids = batch.map((wr) => wr.WorkRequestID).filter((id): id is number => typeof id === "number");
    const existing = new Map<number, string | null>();
    const checked = new Set<number>();
    if (ids.length > 0) {
      const found = await executeQuery(
        connection,
        `SELECT wr.WorkRequestID, wr.LastModifiedDate, i.AttachmentsCheckedAt
         FROM dbo.WorkRequests wr LEFT JOIN dbo.MyBuildingsImportRequests i ON i.WorkRequestID = wr.WorkRequestID
         WHERE wr.WorkRequestID IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids))`,
        [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(ids.map((id) => Math.trunc(id))) }],
      );
      for (const row of found) {
        existing.set(row.WorkRequestID as number, (row.LastModifiedDate as string | null) ?? null);
        if (row.AttachmentsCheckedAt) checked.add(row.WorkRequestID as number);
      }
    }

    for (const wr of batch) {
      const bucket = counts(wr.BuildingName);
      bucket.seen += 1;
      if (typeof wr.WorkRequestID !== "number") {
        flag({ buildingName: wr.BuildingName ?? null, kind: "id", reason: "No WorkRequestID in the myBuildings record", workRequestId: null }, bucket, "request");
        continue;
      }
      if (wr.BuildingID === undefined) {
        flag({ buildingName: wr.BuildingName ?? null, kind: "building", reason: `Building "${wr.BuildingName ?? ""}" is not in Floorplan's Buildings`, workRequestId: wr.WorkRequestID }, bucket, "request");
        continue;
      }

      const had = existing.has(wr.WorkRequestID);
      const same = had && existing.get(wr.WorkRequestID) === (wr.LastModifiedDate ?? null);
      if (same) bucket.unchanged += 1;
      else if (had) bucket.updated += 1;
      else bucket.inserted += 1;
      if (!options.dryRun && !same) await deps.upsertWorkRequest(connection, wr);

      const needsAttachments = options.recheckAttachments || !checked.has(wr.WorkRequestID);
      if (!needsAttachments) continue;
      if (attachmentBudget <= 0) { attachmentsPending += 1; continue; }
      attachmentBudget -= 1;
      await importAttachments(connection, wr, bucket, deps, options, runId, flag, log);
    }
    log(`import: ${Math.min(start + IMPORT_BATCH_SIZE, resolved.length)}/${resolved.length} requests`);
  }

  for (const b of Object.values(byBuilding)) {
    for (const key of Object.keys(totals) as (keyof BuildingCounts)[]) totals[key] += b[key];
  }
  for (const [name, b] of Object.entries(byBuilding)) log(`import ${options.dryRun ? "(dry run) " : ""}${name}: ${JSON.stringify(b)}`);

  if (!options.dryRun && runId !== null) {
    for (const f of flags) {
      await executeQuery(
        connection,
        `INSERT INTO dbo.MyBuildingsImportFlags (RunId, WorkRequestID, BuildingName, Kind, Reason) VALUES (@RunId, @WorkRequestID, @BuildingName, @Kind, @Reason)`,
        [
          { name: "RunId", type: TYPES.Int, value: runId },
          { name: "WorkRequestID", type: TYPES.Int, value: f.workRequestId },
          { name: "BuildingName", type: TYPES.NVarChar, value: f.buildingName },
          { name: "Kind", type: TYPES.NVarChar, value: f.kind },
          { name: "Reason", type: TYPES.NVarChar, value: f.reason.slice(0, 500) },
        ],
      );
    }
    await executeQuery(
      connection,
      `UPDATE dbo.MyBuildingsImportRuns SET FinishedAt = SYSUTCDATETIME(), Summary = @Summary, FlaggedCount = @Flagged WHERE RunId = @RunId`,
      [
        { name: "RunId", type: TYPES.Int, value: runId },
        { name: "Summary", type: TYPES.NVarChar, value: JSON.stringify({ byBuilding, totals, attachmentsPending }) },
        { name: "Flagged", type: TYPES.Int, value: flags.length },
      ],
    );
  }

  return { attachmentsPending, byBuilding, dryRun: options.dryRun, flagged: flags.length, flags: flags.slice(0, MAX_FLAGS_RETURNED), runId, totals };
}

async function importAttachments(
  connection: Connection,
  wr: MyWorkRequest,
  bucket: BuildingCounts,
  deps: ImportDeps,
  options: ImportOptions,
  runId: number | null,
  flag: (f: ImportFlag, bucket: BuildingCounts, kind: "request" | "attachment") => void,
  log: (message: string) => void,
): Promise<void> {
  const workRequestId = wr.WorkRequestID as number;
  const base = { buildingName: wr.BuildingName ?? null, workRequestId };
  let refs: MyAttachmentRef[];
  try {
    refs = await deps.fetchAttachments(workRequestId);
  } catch (error) {
    // Left unchecked on purpose, so the next run tries again.
    flag({ ...base, kind: "attachment_listing", reason: `Attachment list unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }, bucket, "attachment");
    return;
  }

  let allHandled = true;
  for (const ref of refs) {
    const key = sourceKeyOf(ref);
    const name = nameOf(ref);
    if (key === null || !ref.Attachment_URL) {
      allHandled = false;
      flag({ ...base, kind: "attachment", reason: `Attachment "${name}" has no id or URL` }, bucket, "attachment");
      continue;
    }
    const known = await executeQuery(
      connection,
      `SELECT TOP 1 1 AS Found FROM dbo.MyBuildingsImportAttachments WHERE WorkRequestID = @Wr AND SourceKey = @Key
       UNION ALL
       SELECT TOP 1 1 FROM dbo.Attachments WHERE WorkRequestID = @Wr AND OriginalName = @Name`,
      [
        { name: "Wr", type: TYPES.Int, value: workRequestId },
        { name: "Key", type: TYPES.NVarChar, value: key },
        { name: "Name", type: TYPES.NVarChar, value: name },
      ],
    );
    if (known.length > 0) { bucket.attachmentsSkipped += 1; continue; }
    if (options.dryRun) { bucket.attachmentsImported += 1; continue; }

    try {
      const { bytes, contentType } = await deps.downloadAttachment(ref.Attachment_URL);
      const ext = (ref.Attachment_Extension ?? name.split(".").pop() ?? "").replace(/^\./, "").toLowerCase();
      const type = normaliseMediaType(ref.ContentType || contentType || MIME_BY_EXTENSION[ext] || "");
      if (bytes.length > MAX_SIZE_BYTES) throw new Error("file is over the size limit");
      if (!isAllowedContentType(type)) throw new Error(`file type "${type || "unknown"}" is not allowed`);
      if (!bytesMatchMediaType(type, bytes)) throw new Error("file contents do not match its type");

      const blobName = await deps.storeBlob(bytes, name, type, `attachments/workRequests/${workRequestId}`);
      const inserted = await executeQuery(
        connection,
        `INSERT INTO dbo.Attachments (WorkRequestID, BlobName, OriginalName, Extension, ContentType, SizeBytes, UploadedBy)
         OUTPUT INSERTED.Id VALUES (@Wr, @Blob, @Name, @Ext, @Type, @Size, @By)`,
        [
          { name: "Wr", type: TYPES.Int, value: workRequestId },
          { name: "Blob", type: TYPES.NVarChar, value: blobName },
          { name: "Name", type: TYPES.NVarChar, value: name },
          { name: "Ext", type: TYPES.NVarChar, value: ext.slice(0, 20) },
          { name: "Type", type: TYPES.NVarChar, value: type },
          { name: "Size", type: TYPES.BigInt, value: bytes.length },
          { name: "By", type: TYPES.NVarChar, value: IMPORT_ACTOR },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO dbo.MyBuildingsImportAttachments (WorkRequestID, SourceKey, SourceName, SourceUrl, AttachmentId, RunId)
         VALUES (@Wr, @Key, @Name, @Url, @AttachmentId, @RunId)`,
        [
          { name: "Wr", type: TYPES.Int, value: workRequestId },
          { name: "Key", type: TYPES.NVarChar, value: key },
          { name: "Name", type: TYPES.NVarChar, value: name },
          { name: "Url", type: TYPES.NVarChar, value: ref.Attachment_URL.slice(0, 1000) },
          { name: "AttachmentId", type: TYPES.Int, value: inserted[0].Id as number },
          { name: "RunId", type: TYPES.Int, value: runId },
        ],
      );
      bucket.attachmentsImported += 1;
    } catch (error) {
      allHandled = false;
      log(`import: WR ${workRequestId} attachment "${name}" not imported`);
      flag({ ...base, kind: "attachment", reason: `Attachment "${name}": ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }, bucket, "attachment");
    }
  }

  if (!options.dryRun && allHandled) {
    await executeQuery(
      connection,
      `MERGE dbo.MyBuildingsImportRequests WITH (HOLDLOCK) AS t USING (SELECT @Wr AS WorkRequestID) AS s ON t.WorkRequestID = s.WorkRequestID
       WHEN MATCHED THEN UPDATE SET LastRunId = @RunId, BuildingName = @Building, AttachmentsCheckedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (WorkRequestID, BuildingName, FirstRunId, LastRunId, AttachmentsCheckedAt) VALUES (@Wr, @Building, @RunId, @RunId, SYSUTCDATETIME());`,
      [
        { name: "Wr", type: TYPES.Int, value: workRequestId },
        { name: "RunId", type: TYPES.Int, value: runId },
        { name: "Building", type: TYPES.NVarChar, value: wr.BuildingName ?? null },
      ],
    );
  }
}
