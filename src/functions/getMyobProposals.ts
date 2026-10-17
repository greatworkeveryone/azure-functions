import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { canPropose, forbidden, withCaller } from "../myob/proposalHttp";
import { openProposals, proposalsForSubject } from "../myob/proposalsStore";

// GET /api/getMyobProposals?subjectType=purchase_order&subjectId=9  (a record's history)
// GET /api/getMyobProposals?queue=open                              (the CFO's review queue)
// Readable by whoever may propose, the CFO, directors and admin. Says whether
// the caller may propose and whether they may approve and send.

const READERS = new Set(["admin", "director", "cfo", "accounts_manager", "facilities_manager"]);

export async function getMyobProposals(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return withCaller(request, context, "getMyobProposals", async ({ connection, isController, roles }) => {
    if (!roles.some((role) => READERS.has(role))) return forbidden("Your role can't see MYOB proposals");
    const subjectType = request.query.get("subjectType");
    const subjectId = Number(request.query.get("subjectId"));
    let proposals;
    if (request.query.get("queue") === "open") proposals = await openProposals(connection);
    else if ((subjectType === "purchase_order" || subjectType === "quote") && Number.isInteger(subjectId) && subjectId > 0) {
      proposals = await proposalsForSubject(connection, subjectType, subjectId);
    } else return { jsonBody: { error: "Ask for a record (subjectType and subjectId) or queue=open" }, status: 400 };
    return { jsonBody: { canPropose: canPropose(roles), canSend: isController, proposals }, status: 200 };
  });
}

app.http("getMyobProposals", { authLevel: "anonymous", handler: getMyobProposals, methods: ["GET"] });
