import { randomUUID } from "crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { propose } from "../myob/propose";
import { canPropose, forbidden, inTx, readPreview, readSubject, withCaller } from "../myob/proposalHttp";

// POST /api/proposeToMyob — "Propose to MYOB" or "Update in MYOB" (decision
// 12): { subjectType, subjectId, operation, payloadHash, previewedAt } from the
// preview the person saw. Records the proposal for the CFO; sends nothing.

export async function proposeToMyob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return withCaller(request, context, "proposeToMyob", async ({ connection, person, roles }) => {
    if (!canPropose(roles)) return forbidden("Your role can't propose records to MYOB");
    const subject = readSubject(body);
    const preview = readPreview(body);
    if (!subject || !preview) return { jsonBody: { error: "Preview the record first, then propose it" }, status: 400 };
    const proposal = await inTx(connection, (tx) => propose(tx, person, { ...subject, ...preview }, randomUUID(), new Date()));
    return { jsonBody: { proposal }, status: 200 };
  });
}

app.http("proposeToMyob", { authLevel: "anonymous", handler: proposeToMyob, methods: ["POST"] });
