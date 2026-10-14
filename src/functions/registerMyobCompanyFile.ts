import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { registerCompanyFile } from "../myob-company-files-admin";
import { parseRegister } from "../myob-company-files-input";
import { runControllerAction } from "../myob-controller-handler";

// POST /api/registerMyobCompanyFile — the CFO registers a MYOB company file by
// id (MYOB no longer lists cloud files): { companyFileId, name?, note }. It
// starts off. Role cfo only; ledgered as myob.control_change; 409 if known.

export function registerMyobCompanyFile(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction(request, context, {
    failure: "Failed to register the MYOB company file",
    forbidden: "Only the CFO can register MYOB company files",
    name: "registerMyobCompanyFile",
    parse: parseRegister,
    work: async (tx, actor, input) => ({ file: await registerCompanyFile(tx, actor, input) }),
  });
}

app.http("registerMyobCompanyFile", { authLevel: "anonymous", handler: registerMyobCompanyFile, methods: ["POST"] });
