import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { verifiedIdentityFromRequest } from "../auth";
import { myobRequest, MyobRequestRefusedError, userActor } from "../myob-api-log";
import { getValidMyobAccessToken, MyobNotLinkedError, MyobRelinkRequiredError } from "../myob-auth";
import { recordDiscoveredFiles, type ListedFile } from "../myob-company-files-admin";
import { runControllerAction } from "../myob-controller-handler";
import { myobApiBase } from "../myob-endpoints";
import { MyobControlsError } from "../myob-controls-admin";

// POST /api/discoverMyobCompanyFiles — asks MYOB which company files the
// linked login can see (GET /accountright/, through myobRequest, so the
// allowlist, the configured file's mode and its controls apply) and registers
// any Floorplan doesn't know, switched off. MYOB has hidden cloud files from
// that list since 2026, so registering by id stays the main way in. Role cfo only.

async function listFiles(request: HttpRequest, sqlToken: string): Promise<ListedFile[]> {
  const identity = await verifiedIdentityFromRequest(request);
  const actor = userActor(identity ?? { name: "unknown" }, ["cfo"]);
  try {
    const response = await myobRequest({
      actor,
      headers: async () => ({
        Accept: "application/json",
        Authorization: `Bearer ${await getValidMyobAccessToken(sqlToken, actor)}`,
        "x-myobapi-key": process.env.MYOB_CLIENT_ID ?? "",
        "x-myobapi-version": "v2",
      }),
      method: "GET",
      purpose: "discover-company-files",
      url: `${myobApiBase()}/`,
    });
    if (!response.ok) throw new MyobControlsError(409, `MYOB answered ${response.status} to the file list`);
    const listed = response.json<unknown>();
    return Array.isArray(listed) ? (listed as ListedFile[]) : [];
  } catch (error) {
    if (error instanceof MyobRequestRefusedError || error instanceof MyobNotLinkedError || error instanceof MyobRelinkRequiredError) {
      throw new MyobControlsError(409, error.message);
    }
    throw error;
  }
}

export function discoverMyobCompanyFiles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction<ListedFile[]>(request, context, {
    failure: "Failed to read MYOB's company files",
    forbidden: "Only the CFO can look for MYOB company files",
    name: "discoverMyobCompanyFiles",
    parse: () => ({ ok: true, value: [] }),
    // MYOB is read before the transaction opens, so no lock waits on the network.
    prepare: (_none, token) => listFiles(request, token),
    work: (tx, actor, listed) => recordDiscoveredFiles(tx, actor, listed),
  });
}

app.http("discoverMyobCompanyFiles", { authLevel: "anonymous", handler: discoverMyobCompanyFiles, methods: ["POST"] });
