import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { changeFileSettings } from "../myob-company-files-admin";
import { parseFileSettings } from "../myob-company-files-input";
import { runControllerAction } from "../myob-controller-handler";

// POST /api/setMyobFileMode — the CFO sets a MYOB company file's mode
// (off | read | write) and whether it is the demonstration file:
// { companyFileId, mode?, isDemonstration?, note, expectedRowVersion }.
// Role cfo only. Ledgered as myob.control_change; a stale version is 409.

export function setMyobFileMode(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction(request, context, {
    failure: "Failed to change the MYOB company file",
    forbidden: "Only the CFO can change which MYOB company files Floorplan may touch",
    name: "setMyobFileMode",
    parse: parseFileSettings,
    work: async (tx, actor, input) => {
      const result = await changeFileSettings(tx, actor, input);
      return { changed: result.changed, file: result.row };
    },
  });
}

app.http("setMyobFileMode", { authLevel: "anonymous", handler: setMyobFileMode, methods: ["POST"] });
