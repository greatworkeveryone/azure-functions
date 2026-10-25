// POST /api/runSchedulerNow   Body: { dryRun?: boolean }   (admin)
//
// Runs the facilities scheduler on demand, for checking a staging database or
// catching up after an outage. A dry run (the default) writes nothing and
// returns what it would do. A live run is refused unless the scheduler is
// switched on (SCHEDULER_ENABLED=true and SCHEDULER_DRY_RUN not true), so this
// endpoint can never write where the timer may not. Response: { report, log }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, conflict, errorMessage, readJsonBody } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection } from "../db";
import { RUN_SCHEDULER_ROLES } from "../facilitiesRoles";
import { runFacilitiesScheduler, schedulerMaxActions, schedulerMode } from "../facilitiesScheduler";

export async function runSchedulerNow(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, RUN_SCHEDULER_ROLES);
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) ?? {};
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return badRequest("dryRun must be true or false");
  const dryRun = body.dryRun !== false;
  if (!dryRun && schedulerMode() !== "live") {
    return conflict("The scheduler is switched off here (SCHEDULER_ENABLED is not true, or SCHEDULER_DRY_RUN is on). Run a dry run instead.");
  }

  const log: string[] = [];
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const report = await runFacilitiesScheduler(connection, {
      dryRun,
      log: (message) => {
        log.push(message);
        context.log(message);
      },
      maxActions: schedulerMaxActions(),
      warn: (message) => {
        log.push(message);
        context.warn(message);
      },
    });
    return { jsonBody: { log, report }, status: 200 };
  } catch (error) {
    context.error("runSchedulerNow failed:", errorMessage(error));
    return errorResponse("The scheduler run failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("runSchedulerNow", { authLevel: "anonymous", handler: runSchedulerNow, methods: ["POST"] });
