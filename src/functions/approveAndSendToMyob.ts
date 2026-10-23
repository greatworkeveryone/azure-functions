import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { forbidden, inTx, jobLink, readPreview, withCaller } from "../myob/proposalHttp";
import { isMyobController } from "../myob-controls-admin";
import { approveAndSend } from "../myob/send";
import { LIVE_PURCHASES } from "../myob/sendSteps";

// POST /api/approveAndSendToMyob — "Approve and send to MYOB" (decision 12):
// { proposalId, payloadHash, previewedAt, expectedRowVersion }. The CFO only;
// not the proposer while review is required. Sends exactly the previewed bytes,
// one record, then reads it back. Answers with what MYOB returned.

export async function approveAndSendToMyob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return withCaller(request, context, "approveAndSendToMyob", async ({ connection, isController, person }) => {
    if (!isController) return forbidden("Only the CFO can approve and send to MYOB");
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const preview = readPreview(body);
    const proposalId = Number(body.proposalId);
    if (!preview || !Number.isInteger(proposalId) || typeof body.expectedRowVersion !== "string") {
      return { jsonBody: { error: "Preview the proposal first, then approve it" }, status: 400 };
    }
    const outcome = await approveAndSend(
      { link: jobLink, myob: LIVE_PURCHASES, now: () => new Date(), withTx: (work) => inTx(connection, work) },
      person,
      { ...preview, expectedRowVersion: body.expectedRowVersion, proposalId },
    );
    return { jsonBody: outcome, status: 200 };
  }, { allowed: isMyobController, forbidden: "Only the CFO can approve and send to MYOB" });
}

app.http("approveAndSendToMyob", { authLevel: "anonymous", handler: approveAndSendToMyob, methods: ["POST"] });
