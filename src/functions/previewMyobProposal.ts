import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { buildDraft } from "../myob/draft";
import { canPropose, forbidden, jobLink, readSubject, withCaller } from "../myob/proposalHttp";
import { getProposal } from "../myob/proposalsStore";
import type { ProposalSubjectType } from "../myob/subjects";

// POST /api/previewMyobProposal — what a MYOB click would do, before anything
// happens (decision 12). Reads only; calls nothing in MYOB.
//   { subjectType, subjectId, operation }  for "Propose to MYOB" / "Update in MYOB"
//   { proposalId }                         for "Approve and send" (the CFO)
// Returns the record in the CFO's words, the payload hash and the preview
// time; the click must send both back, and is refused if the record moved.

export async function previewMyobProposal(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return withCaller(request, context, "previewMyobProposal", async ({ connection, isController, person, roles }) => {
    const previewedAt = new Date();
    let result;
    if (body.proposalId !== undefined) {
      if (!isController) return forbidden("Only the CFO can approve and send to MYOB");
      const proposal = await getProposal(connection, Number(body.proposalId));
      if (!proposal) return { jsonBody: { error: "That MYOB proposal doesn't exist" }, status: 404 };
      result = await buildDraft(connection, {
        approver: { at: previewedAt, name: person.name },
        link: jobLink(proposal.jobId),
        operation: proposal.operation,
        proposalId: proposal.proposalId,
        proposer: { at: new Date(proposal.proposedAt), name: proposal.proposedBy },
        subjectId: proposal.subjectId,
        subjectType: proposal.subjectType as ProposalSubjectType,
      });
    } else {
      if (!canPropose(roles)) return forbidden("Your role can't propose records to MYOB");
      const subject = readSubject(body);
      if (!subject) return { jsonBody: { error: "subjectType, subjectId and operation are required" }, status: 400 };
      result = await buildDraft(connection, { ...subject, proposer: { at: previewedAt, name: person.name } });
    }
    if (!result.ok) return { jsonBody: { error: result.reasons.join(" "), reasons: result.reasons }, status: result.status };
    const { draft } = result;
    return {
      jsonBody: {
        companyFile: { id: draft.companyFileId, mode: draft.mapping.companyFile.mode, name: draft.mapping.companyFile.name },
        payloadHash: draft.payloadHash,
        previewedAt: previewedAt.toISOString(),
        rendered: draft.rendered,
      },
      status: 200,
    };
  });
}

app.http("previewMyobProposal", { authLevel: "anonymous", handler: previewMyobProposal, methods: ["POST"] });
