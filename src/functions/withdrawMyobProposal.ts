import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { canPropose, forbidden, inTx, withCaller } from "../myob/proposalHttp";
import { withdrawProposal } from "../myob/withdraw";

// POST /api/withdrawMyobProposal — { proposalId, reason, expectedRowVersion }.
// The proposer or the CFO; only while proposed or after an exception. The row
// stays, marked withdrawn with who and why.

export async function withdrawMyobProposal(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return withCaller(request, context, "withdrawMyobProposal", async ({ connection, isController, person, roles }) => {
    if (!canPropose(roles) && !isController) return forbidden("Your role can't withdraw MYOB proposals");
    const proposalId = Number(body.proposalId);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!Number.isInteger(proposalId) || !reason || typeof body.expectedRowVersion !== "string") {
      return { jsonBody: { error: "proposalId, a reason and expectedRowVersion are required" }, status: 400 };
    }
    const proposal = await inTx(connection, (tx) =>
      withdrawProposal(tx, person, isController, { expectedRowVersion: body.expectedRowVersion as string, proposalId, reason }, new Date()),
    );
    return { jsonBody: { proposal }, status: 200 };
  });
}

app.http("withdrawMyobProposal", { authLevel: "anonymous", handler: withdrawMyobProposal, methods: ["POST"] });
