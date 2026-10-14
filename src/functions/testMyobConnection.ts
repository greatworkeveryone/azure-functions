import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { myobRequest, MyobRequestRefusedError, userActor } from "../myob-api-log";
import { getValidMyobAccessToken, MyobNotLinkedError, MyobRelinkRequiredError } from "../myob-auth";

// Verifies the MYOB integration end-to-end by:
//   1. Pulling the stored access token (refreshing if expired)
//   2. Calling GET /accountright/ to list visible company files
//   3. Reporting whether MYOB_COMPANY_FILE_ID matches one of them; since 2026
//      MYOB leaves cloud files out of that list, a configured file that isn't
//      listed is checked directly with GET /accountright/{file}/
// Both reads go through myobRequest, so the allowlist and controls apply.

interface MyobCompanyFile {
  Id: string;
  Name: string;
  LibraryPath?: string;
  ProductVersion?: string;
  ProductLevel?: { Code?: number; Name?: string };
  Country?: string;
  Uri?: string;
}

interface ConfigStatus {
  apiBase: boolean;
  clientId: boolean;
  clientSecret: boolean;
  redirectUri: boolean;
  companyFileId: boolean;
}

interface TestResponse {
  ok: boolean;
  message: string;
  configStatus: ConfigStatus;
  linked: boolean;
  configuredFileId: string | null;
  configuredFileFound: boolean;
  configuredFileName: string | null;
  companyFiles: MyobCompanyFile[];
}

async function testMyobConnection(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const forbidden = await requireRole(request, [AppRole.ADMIN]);
  if (forbidden) return forbidden;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const actor = userActor(identity, [AppRole.ADMIN]);

  const apiBase = process.env.MYOB_API_BASE ?? "https://api.myob.com/accountright";
  const clientId = process.env.MYOB_CLIENT_ID ?? "";
  const clientSecret = process.env.MYOB_CLIENT_SECRET ?? "";
  const redirectUri = process.env.MYOB_REDIRECT_URI ?? "";
  const companyFileId = process.env.MYOB_COMPANY_FILE_ID ?? "";

  const configStatus: ConfigStatus = {
    apiBase: Boolean(apiBase),
    clientId: Boolean(clientId),
    clientSecret: Boolean(clientSecret),
    redirectUri: Boolean(redirectUri),
    companyFileId: Boolean(companyFileId),
  };

  const missing = [
    !clientId ? "MYOB_CLIENT_ID" : null,
    !clientSecret ? "MYOB_CLIENT_SECRET" : null,
    !redirectUri ? "MYOB_REDIRECT_URI" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    const body: TestResponse = {
      ok: false,
      message: `Missing required env var(s): ${missing.join(", ")}`,
      configStatus,
      linked: false,
      configuredFileId: companyFileId || null,
      configuredFileFound: false,
      configuredFileName: null,
      companyFiles: [],
    };
    return { status: 200, jsonBody: body };
  }

  let accessToken: string;
  try {
    accessToken = await getValidMyobAccessToken(token, actor);
  } catch (error) {
    if (error instanceof MyobNotLinkedError || error instanceof MyobRelinkRequiredError) {
      const body: TestResponse = {
        ok: false,
        message: error instanceof MyobRelinkRequiredError ? error.message : "MYOB is not linked yet — click Authorize MYOB above.",
        configStatus,
        linked: false,
        configuredFileId: companyFileId || null,
        configuredFileFound: false,
        configuredFileName: null,
        companyFiles: [],
      };
      return { status: 200, jsonBody: body };
    }
    const message = error instanceof Error ? error.message : String(error);
    context.error("Token refresh failed:", message);
    return errorResponse("MYOB token refresh failed", message);
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "x-myobapi-key": clientId,
    "x-myobapi-version": "v2",
    Accept: "application/json",
  };
  try {
    context.log("Testing MYOB connection — fetching company files");
    const response = await myobRequest({ actor, headers, method: "GET", purpose: "test-connection", url: `${apiBase}/` });

    if (!response.ok) {
      const body: TestResponse = {
        ok: false,
        message: `MYOB API ${response.status} ${response.statusText}: ${response.text.slice(0, 300)}`,
        configStatus,
        linked: true,
        configuredFileId: companyFileId || null,
        configuredFileFound: false,
        configuredFileName: null,
        companyFiles: [],
      };
      return { status: 200, jsonBody: body };
    }

    const files = response.json<MyobCompanyFile[]>();
    const configured = companyFileId
      ? files.find((file) => file.Id.toLowerCase() === companyFileId.toLowerCase()) ?? null
      : null;
    const reachable =
      Boolean(configured) ||
      (companyFileId !== "" &&
        (await myobRequest({ actor, headers, method: "GET", purpose: "test-connection-file", url: `${apiBase}/${companyFileId}/` })).ok);

    const body: TestResponse = {
      ok: true,
      message: companyFileId
        ? configured
          ? `Connected — ${files.length} company file(s), configured file found.`
          : reachable
            ? `Connected — the configured file answers (MYOB no longer lists cloud files; ${files.length} listed).`
            : `Connected — ${files.length} company file(s), but the configured file did not answer.`
        : `Connected — ${files.length} company file(s). MYOB_COMPANY_FILE_ID is not set.`,
      configStatus,
      linked: true,
      configuredFileId: companyFileId || null,
      configuredFileFound: reachable,
      configuredFileName: configured?.Name ?? null,
      companyFiles: files,
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
    if (error instanceof MyobRequestRefusedError) {
      const body: TestResponse = {
        ok: false,
        message: `Refused inside Floorplan: ${error.message}`,
        configStatus,
        linked: true,
        configuredFileId: companyFileId || null,
        configuredFileFound: false,
        configuredFileName: null,
        companyFiles: [],
      };
      return { status: 200, jsonBody: body };
    }
    const message = error instanceof Error ? error.message : String(error);
    context.error("MYOB connection test failed:", message);
    return errorResponse("MYOB connection test failed", message);
  }
}

app.http("testMyobConnection", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: testMyobConnection,
});
