import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "../myob-errors";
import { runControllerAction } from "../myob-controller-handler";
import { MyobControlsError } from "../myob-controls-admin";
import { acceptBaseline, readForAcceptance, type AcceptInput } from "../myob/activity/acceptBaseline";
import { getProposal } from "../myob/proposalsStore";
import { LIVE_READER } from "../myob/readbackClient";

// POST /api/acceptMyobBaseline — { proposalId, expectedRowVersion,
// myobRowVersion, note }: the CFO accepts MYOB's record as the baseline for a
// record Floorplan sent (SPR-M4). MYOB is read again (GET only) before the
// transaction, and the record must still be the version she checked. Only
// Floorplan's mirror (MyobProposals) changes; ledgered as myob.control_change
// with her note. Role cfo only (the M9 controller gate; myobController).

function parse(body: unknown): { ok: true; value: AcceptInput } | { error: string; ok: false } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(b.proposalId) || Number(b.proposalId) <= 0) return { error: "proposalId is required", ok: false };
  if (typeof b.expectedRowVersion !== "string" || !b.expectedRowVersion) return { error: "expectedRowVersion is the version you checked", ok: false };
  if (typeof b.myobRowVersion !== "string" || !b.myobRowVersion) return { error: "myobRowVersion is MYOB's version you checked", ok: false };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (!note || note.length > 1000) return { error: "A note (up to 1000 characters) is required", ok: false };
  return { ok: true, value: { expectedRowVersion: b.expectedRowVersion, myobRecord: null, myobRowVersion: b.myobRowVersion, note, proposalId: Number(b.proposalId) } };
}

export async function acceptMyobBaseline(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // The MYOB log must name a real person: no verified identity, no call.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  return runControllerAction(request, context, {
    failure: "Failed to accept MYOB's record",
    forbidden: "Only the CFO can accept MYOB's record as the baseline",
    name: "acceptMyobBaseline",
    parse,
    // MYOB is read before the transaction opens, so no lock waits on the network.
    prepare: async (input, token) => {
      const connection = await createRequestConnection(token);
      try {
        const proposal = await getProposal(connection, input.proposalId);
        if (!proposal) throw new MyobControlsError(404, "That MYOB record isn't one Floorplan sent");
        const actor = { kind: "user" as const, name: identity.name, oid: identity.oid };
        return { ...input, myobRecord: await readForAcceptance(proposal, actor, LIVE_READER) };
      } catch (error) {
        if (error instanceof MyobRequestRefusedError || error instanceof MyobWritesDisabledError) throw new MyobControlsError(409, `MYOB couldn't be read: ${error.message}`);
        throw error;
      } finally {
        closeConnection(connection);
      }
    },
    work: async (tx, actor, input) => ({ accepted: true, proposal: await acceptBaseline(tx, actor, input, new Date()) }),
  });
}

app.http("acceptMyobBaseline", { authLevel: "anonymous", handler: acceptMyobBaseline, methods: ["POST"] });
