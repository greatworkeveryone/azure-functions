import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, rolesForRequest, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { runControllerAction } from "../myob-controller-handler";
import { isMyobController, MyobControlsError } from "../myob-controls-admin";
import { LAB_CASES } from "../myob/lab/cases";
import { LAB_PROBES, runLabProbe, type LabProbe } from "../myob/lab/probes";
import { loadLabResults, recordLabResult } from "../myob/lab/results";
import { loadLabStatus } from "../myob/lab/status";
import type { Connection } from "tedious";

// Johanne's MYOB lab (plan M5): sessions on a demonstration company file that
// isn't RP's. GET getMyobLab (cfo, director, admin, as the other MYOB views;
// the frontend's viewMyobControls) shows whether the lab may run, the scripted
// cases and her latest result for each. runMyobLabProbe and recordMyobLabResult
// are the CFO's (the M9 controller gate; myobController): a probe asks
// Floorplan's guard about a forbidden request and sends nothing; a result is
// ledgered (myob.lab_result) with her note. Both refuse until the lab is ready.

async function readyDemo(tx: Connection): Promise<string> {
  const status = await loadLabStatus(tx);
  if (!status.ready || !status.demoFile) throw new MyobControlsError(409, `The lab isn't ready: ${status.problems.join("; ")}`);
  return status.demoFile.id;
}

export async function getMyobLab(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.CFO]);
  if (forbidden) return forbidden;
  let connection;
  try {
    const roles = await rolesForRequest(request);
    connection = await createRequestConnection(token);
    const status = await loadLabStatus(connection);
    const results = status.demoFile ? await loadLabResults(connection, status.demoFile.id) : new Map();
    const cases = LAB_CASES.map((labCase) => ({ ...labCase, result: results.get(labCase.id) ?? null }));
    return { jsonBody: { canRecord: isMyobController(roles), cases, status }, status: 200 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getMyobLab failed:", message);
    return errorResponse("Failed to load the MYOB lab", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export function runMyobLabProbe(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction(request, context, {
    failure: "Failed to run the lab probe",
    forbidden: "Only the CFO runs the MYOB lab",
    name: "runMyobLabProbe",
    parse: (body) => {
      const probe = (body as Record<string, unknown> | null)?.probe;
      return typeof probe === "string" && probe in LAB_PROBES ? { ok: true, value: probe as LabProbe } : { error: `probe must be one of ${Object.keys(LAB_PROBES).join(", ")}`, ok: false };
    },
    work: async (tx, _actor, probe) => ({ result: await runLabProbe(probe, await readyDemo(tx), new Date()) }),
  });
}

export function recordMyobLabResult(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction(request, context, {
    failure: "Failed to record the lab result",
    forbidden: "Only the CFO records MYOB lab results",
    name: "recordMyobLabResult",
    parse: (body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const note = typeof b.note === "string" ? b.note.trim() : "";
      if (typeof b.caseId !== "string" || !b.caseId) return { error: "caseId is required", ok: false };
      if (typeof b.pass !== "boolean") return { error: "pass must be true or false", ok: false };
      if (!note || note.length > 1000) return { error: "A note (up to 1000 characters) is required", ok: false };
      const observed = typeof b.observed === "string" ? b.observed.trim().slice(0, 2000) : "";
      const proposalId = Number.isInteger(b.proposalId) && Number(b.proposalId) > 0 ? Number(b.proposalId) : null;
      return { ok: true, value: { caseId: b.caseId, note, observed, pass: b.pass, proposalId } };
    },
    work: async (tx, actor, input) => {
      await recordLabResult(tx, actor, input, await readyDemo(tx));
      return { recorded: true };
    },
  });
}

app.http("getMyobLab", { authLevel: "anonymous", handler: getMyobLab, methods: ["GET"] });
app.http("runMyobLabProbe", { authLevel: "anonymous", handler: runMyobLabProbe, methods: ["POST"] });
app.http("recordMyobLabResult", { authLevel: "anonymous", handler: recordMyobLabResult, methods: ["POST"] });
