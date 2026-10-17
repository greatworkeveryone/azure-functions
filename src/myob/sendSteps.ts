// The MYOB half of "Approve and send" (decision 12), run after the approval
// has committed and outside any transaction:
//   create  look the number up first, and link an existing record instead of
//           creating a second one; otherwise POST the exact approved bytes
//   update  read the record and refuse if MYOB's RowVersion moved since
//           Floorplan last saw it (someone edited it in MYOB); otherwise PUT
//   both    read the record back and compare it field by field
// Nothing here retries: a failure becomes an exception for a person to look at.

import { MyobRequestRefusedError, MyobWritesDisabledError, type MyobActor } from "../myob-api-log";
import type { MyobRefusalCode } from "../myob-errors";
import {
  createPurchase,
  findPurchaseByNumber,
  getPurchase,
  MyobPurchaseError,
  putPurchase,
  type PurchaseKind,
} from "../myob-purchase-order";
import { canonicalJson } from "./hash";
import { diffDocuments, type FieldDiff } from "./payloads";
import { KIND_OF } from "./kinds";
import type { ProposalRow } from "./proposalsStore";

export { KIND_OF };

export interface MyobPurchases {
  create: typeof createPurchase;
  find: typeof findPurchaseByNumber;
  get: typeof getPurchase;
  put: typeof putPurchase;
}

export const LIVE_PURCHASES: MyobPurchases = { create: createPurchase, find: findPurchaseByNumber, get: getPurchase, put: putPurchase };

export type PushResult =
  | { kind: "verified" | "differs"; diff: FieldDiff[]; linked: boolean; readBack: Record<string, unknown>; uid: string }
  | { kind: "not_ours"; message: string; uid: string }
  | { kind: "changed_in_myob"; diff: FieldDiff[]; readBack: Record<string, unknown> }
  | { kind: "dry_run" | "refused"; message: string; reason: RefusalReason }
  | { kind: "failed"; message: string };

/** Why Floorplan held a request back before it reached MYOB. */
export type RefusalReason = MyobRefusalCode | "writes_disabled";
export type HeldBack = Extract<PushResult, { kind: "dry_run" | "refused" }>;
export const isHeldBack = (result: PushResult): result is HeldBack => result.kind === "dry_run" || result.kind === "refused";

export interface PushInput {
  actor: MyobActor;
  /** For an update: what Floorplan last read back from MYOB. */
  lastSeen: { myobRowVersion: string | null; readBack: Record<string, unknown> | null } | null;
  proposal: ProposalRow;
}

async function readBack(myob: MyobPurchases, input: PushInput, uid: string, linked: boolean): Promise<PushResult> {
  const { proposal } = input;
  const record = await myob.get(KIND_OF[proposal.operation], proposal.companyFileId, uid, input.actor, proposal.correlationId);
  const diff = diffDocuments(proposal.payload, record);
  return { diff, kind: diff.length === 0 ? "verified" : "differs", linked, readBack: record, uid };
}

async function pushCreate(myob: MyobPurchases, input: PushInput): Promise<PushResult> {
  const { actor, proposal } = input;
  const kind = KIND_OF[proposal.operation];
  const number = String(proposal.payload.Number ?? "");
  const existing = await myob.find(kind, proposal.companyFileId, number, actor, proposal.correlationId);
  if (existing?.UID) {
    const uid = String(existing.UID).toLowerCase();
    // Link only a record Floorplan itself sent (an earlier try whose answer was lost): it carries
    // Floorplan's attribution. A record a person made in MYOB is never adopted, so never amended.
    if (!String(existing.JournalMemo ?? "").startsWith(`FP ${number} `)) {
      return {
        kind: "not_ours",
        message: `MYOB already has ${kind} ${number}, and Floorplan didn't create it. Nothing was sent; Johanne reconciles it in MYOB.`,
        uid,
      };
    }
    return readBack(myob, input, uid, true);
  }
  const uid = await myob.create(kind, proposal.companyFileId, canonicalJson(proposal.payload), actor, proposal.correlationId);
  return readBack(myob, input, uid, false);
}

async function pushUpdate(myob: MyobPurchases, input: PushInput): Promise<PushResult> {
  const { actor, proposal } = input;
  const kind = KIND_OF[proposal.operation];
  const uid = proposal.targetUid;
  if (!uid) return { kind: "failed", message: "This update has no MYOB record to update" };
  const current = await myob.get(kind, proposal.companyFileId, uid, actor, proposal.correlationId);
  const seenVersion = input.lastSeen?.myobRowVersion ?? null;
  if (!seenVersion || String(current.RowVersion ?? "") !== seenVersion) {
    return { diff: diffDocuments(input.lastSeen?.readBack ?? {}, current), kind: "changed_in_myob", readBack: current };
  }
  // The approved bytes are the document; MYOB also needs the record's identity and its current version.
  const body = canonicalJson({ ...proposal.payload, RowVersion: current.RowVersion, UID: current.UID ?? uid });
  await myob.put(kind, proposal.companyFileId, uid, body, actor, proposal.correlationId);
  return readBack(myob, input, uid, false);
}

/** Runs the MYOB calls for an approved proposal and says what happened. Never throws for a MYOB outcome. */
export async function pushApproved(myob: MyobPurchases, input: PushInput): Promise<PushResult> {
  try {
    return input.proposal.operation.endsWith(".update") ? await pushUpdate(myob, input) : await pushCreate(myob, input);
  } catch (error) {
    if (error instanceof MyobRequestRefusedError) {
      return { kind: error.code === "dry_run" ? "dry_run" : "refused", message: error.message, reason: error.code };
    }
    if (error instanceof MyobWritesDisabledError) return { kind: "refused", message: error.message, reason: "writes_disabled" };
    if (error instanceof MyobPurchaseError) return { kind: "failed", message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "failed",
      message: `MYOB didn't answer clearly (${message}). The record may or may not exist in MYOB; Floorplan hasn't marked it as sent. Sending again looks it up by number first.`,
    };
  }
}
