// GET /api/getApprovalCandidates?subject=quote|purchase_order|invoice&amount=N[&quoteId=N]
// (LAUNCH-READINESS R2, R13)
//
// Who the caller may name as the manager who agreed: active users who could
// approve this amount of this subject on their own authority (the approval
// core's canApprove, basis own_authority), never the caller. Admin's row counts
// for nothing here (decision 4: admin approves test records only). The list is
// a convenience for the picker; approveQuote, the PO edit and send, and the
// invoice approval each re-check the person named. For a quote it offers only
// whom approveQuote accepts (review 117 D1): manager roles, never whoever
// added the quote (pass quoteId).
//
// 200 { candidates: [{ userId, name, role }] }, by name
// 400 subject or amount malformed

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { canApprove, type Subject } from "../approvalAuthority";
import { loadApprovalFacts } from "../approvalAuthority-db";
import { nameableRoles } from "../attributedApproval";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { samePerson } from "../moneyRules";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { listActiveUsers } from "../escalation/store";

const SUBJECTS: readonly Subject[] = ["quote", "purchase_order", "invoice"];

export async function getApprovalCandidates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.FACILITIES, AppRole.ACCOUNTS]);
  if (denied) return denied;

  const subject = request.query.get("subject") as Subject | null;
  if (!subject || !SUBJECTS.includes(subject)) {
    return { status: 400, jsonBody: { error: `subject must be one of ${SUBJECTS.join(", ")}` } };
  }
  const rawAmount = request.query.get("amount");
  const amount = rawAmount === null || rawAmount.trim() === "" ? NaN : Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 0) return { status: 400, jsonBody: { error: "amount must be a number of $0 or more" } };

  const rawQuoteId = request.query.get("quoteId");
  const quoteId = rawQuoteId === null || rawQuoteId === "" ? null : Number(rawQuoteId);
  if (quoteId !== null && (!Number.isInteger(quoteId) || quoteId <= 0)) return { status: 400, jsonBody: { error: "quoteId must be a quote id" } };

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    connection = await createRequestConnection(token);
    const [facts, users] = await Promise.all([loadApprovalFacts(connection, null), listActiveUsers(connection)]);
    const creator =
      subject === "quote" && quoteId !== null
        ? ((await executeQuery(connection, "SELECT CreatedBy FROM Quotes WHERE QuoteID = @Id", [{ name: "Id", type: TYPES.Int, value: quoteId }]))[0]?.CreatedBy ?? null)
        : null;
    const callerEmail = identity.email.trim().toLowerCase();
    const candidates = users
      .filter((user) => !(user.email && user.email.trim().toLowerCase() === callerEmail))
      .filter((user) => !(subject === "quote" && samePerson(creator, user.name)))
      .filter((user) => {
        const own = [user.role].filter((role) => role && role !== "admin");
        const roles = subject === "quote" ? nameableRoles(own) : own;
        const decision = canApprove({ email: user.email ?? undefined, roles, userId: user.userId }, { amount, buildingId: 0, subject }, facts);
        return decision.allowed && decision.basis === "own_authority";
      })
      .map((user) => ({ name: user.name, role: user.role, userId: user.userId }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId);
    return { status: 200, jsonBody: { candidates } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getApprovalCandidates failed:", message);
    return errorResponse("Failed to list approvers", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getApprovalCandidates", { methods: ["GET"], authLevel: "anonymous", handler: getApprovalCandidates });
