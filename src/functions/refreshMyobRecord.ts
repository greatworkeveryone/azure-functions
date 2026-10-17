import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { forbidden, withCaller } from "../myob/proposalHttp";
import { proposalsForSubject } from "../myob/proposalsStore";
import { proposalView } from "../myob/proposalView";
import { readbackMode, readBackRows } from "../myob/readbackRun";
import { checkRateLimit } from "../rateLimit";

// POST /api/refreshMyobRecord — { subjectType, subjectId }: read back, now, the
// MYOB records Floorplan created for one purchase order or quote (plan M10),
// when someone opens it. A record checked in the last 5 minutes isn't read
// again; a person may ask 10 times a minute. Reads only, through the same
// guards as the timer, and only while MYOB_READBACK_ENABLED=true (otherwise it
// answers with what Floorplan last saw).

const READERS = new Set(["admin", "director", "cfo", "accounts_manager", "facilities_manager"]);
const FRESH_MS = 5 * 60_000;

export async function refreshMyobRecord(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return withCaller(request, context, "refreshMyobRecord", async ({ connection, person, roles }) => {
    if (!roles.some((role) => READERS.has(role))) return forbidden("Your role can't see MYOB records");
    const subjectId = Number(body.subjectId);
    const subjectType = body.subjectType;
    if ((subjectType !== "purchase_order" && subjectType !== "quote") || !Number.isInteger(subjectId) || subjectId <= 0) {
      return { jsonBody: { error: "subjectType and subjectId are required" }, status: 400 };
    }
    const limit = checkRateLimit(`refreshMyobRecord:${person.oid}`, { limit: 10, windowMs: 60_000 });
    if (!limit.allowed) {
      return { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) }, jsonBody: { error: "Too many MYOB checks; try again in a minute" }, status: 429 };
    }

    const now = new Date();
    const mode = readbackMode();
    const all = await proposalsForSubject(connection, subjectType, subjectId);
    const latestPerUid = new Map<string, (typeof all)[number]>();
    for (const row of all) if (row.state === "verified" && row.myobUid && !latestPerUid.has(row.myobUid)) latestPerUid.set(row.myobUid, row);
    const due = [...latestPerUid.values()].filter((row) => !row.lastReadBackAt || now.getTime() - Date.parse(row.lastReadBackAt) > FRESH_MS);

    let counts = null;
    if (mode === "live" && due.length > 0) {
      counts = await readBackRows(connection, due, {
        actors: { ledger: person.ledger, myob: { kind: "user", name: person.name, oid: person.oid } },
        dryRun: false,
        log: (message) => context.log(message),
        now,
      });
    }
    return {
      jsonBody: { checked: counts?.read ?? 0, proposals: (await proposalsForSubject(connection, subjectType, subjectId)).map(proposalView), readback: mode },
      status: 200,
    };
  });
}

app.http("refreshMyobRecord", { authLevel: "anonymous", handler: refreshMyobRecord, methods: ["POST"] });
