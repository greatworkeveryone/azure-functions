// The body of POST /api/extractDocumentFields, checked (SC-AI2). The purpose is
// chosen from `kind` by the route and never read from the body: a client names the
// kind of document, not which prompt or model call to run. A key the route does not
// know, `purpose` included, refuses the request rather than being ignored.

import { DOCUMENT_KINDS, type DocumentKind } from "./documentFields";
import { isRecord, unknownKeys } from "./validate";

export interface ExtractionRequest {
  /** The job the document is for, when the form knows it; the call is logged against it. */
  jobId: number | null;
  kind: DocumentKind;
  text: string;
}

const MAX_JOB_ID = 2_147_483_647;

export function parseExtractionRequest(body: unknown): { error: string } | { request: ExtractionRequest } {
  if (!isRecord(body)) return { error: "Send a JSON object with kind and text." };
  if (unknownKeys(body, ["jobId", "kind", "text"]).length > 0) return { error: "Only kind, text and jobId are accepted." };
  const { jobId, kind, text } = body;
  if (typeof kind !== "string" || !(DOCUMENT_KINDS as readonly string[]).includes(kind)) return { error: "kind must be quote or invoice." };
  if (typeof text !== "string" || text.trim() === "") return { error: "There is no text to read." };
  if (jobId !== undefined && jobId !== null && (typeof jobId !== "number" || !Number.isInteger(jobId) || jobId < 1 || jobId > MAX_JOB_ID)) {
    return { error: "jobId must be a whole number." };
  }
  return { request: { jobId: typeof jobId === "number" ? jobId : null, kind: kind as DocumentKind, text } };
}
