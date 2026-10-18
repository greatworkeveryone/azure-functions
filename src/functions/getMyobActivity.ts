import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { myobApiBase } from "../myob-endpoints";
import { parseActivityQuery } from "../myob/activity/activityInput";
import { CALL_ROWS, loadCallRows, loadProposalRows, loadRegisteredFiles, PROPOSAL_ROWS } from "../myob/activity/activityStore";
import { activityCsv, callView, proposalView } from "../myob/activity/activityView";

// GET /api/getMyobActivity?kind=proposals|calls[&file&state&from&to][&format=csv]
// — the MYOB Activity view (SPR-M4): every proposal (what, by whom, approved by
// whom, sent when, MYOB's answer) or every MYOB call (who, what MYOB said), for
// registered company files. Reads only. Readable by cfo (and director and admin
// through requireRole's hierarchy, as the other MYOB views; the frontend mirrors
// this as viewMyobControls). format=csv gives { filename, text }.

export async function getMyobActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;
  const parsed = parseActivityQuery(request.query);
  if (!parsed.ok) return { jsonBody: { error: parsed.error }, status: 400 };
  const { filters, format, kind } = parsed.value;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const files = await loadRegisteredFiles(connection);
    const raw = kind === "proposals" ? await loadProposalRows(connection, filters) : await loadCallRows(connection, filters);
    const view = kind === "proposals" ? proposalView(raw) : callView(raw, files, myobApiBase(), filters.companyFileId);
    if (format === "csv") return { jsonBody: activityCsv(view, kind), status: 200 };
    const truncated = raw.length >= (kind === "proposals" ? PROPOSAL_ROWS : CALL_ROWS);
    // Calls are read newest first up to CALL_ROWS, then kept to the chosen file: say so when the cap was hit first.
    const truncatedBeforeFileFilter = truncated && kind === "calls" && filters.companyFileId !== null;
    return { jsonBody: { ...view, files: [...files].map(([id, name]) => ({ id, name })), kind, truncated, truncatedBeforeFileFilter }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getMyobActivity failed:", message);
    return errorResponse("Failed to load MYOB activity", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyobActivity", { authLevel: "anonymous", handler: getMyobActivity, methods: ["GET"] });
