import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { getValidMyobAccessToken, MyobNotLinkedError } from "../myob-auth";

// Verifies the MYOB integration end-to-end by:
//   1. Pulling the stored access token (refreshing if expired)
//   2. Calling GET /accountright/ to list visible company files
//   3. Reporting whether MYOB_COMPANY_FILE_ID matches one of them

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
  const forbidden = await requireRole(request, ["Admin"]);
  if (forbidden) return forbidden;

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
    accessToken = await getValidMyobAccessToken(token);
  } catch (error) {
    if (error instanceof MyobNotLinkedError) {
      const body: TestResponse = {
        ok: false,
        message: "MYOB is not linked yet — click Authorize MYOB above.",
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

  try {
    context.log("Testing MYOB connection — fetching company files");
    const response = await fetch(`${apiBase}/`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-myobapi-key": clientId,
        "x-myobapi-version": "v2",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      const body: TestResponse = {
        ok: false,
        message: `MYOB API ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
        configStatus,
        linked: true,
        configuredFileId: companyFileId || null,
        configuredFileFound: false,
        configuredFileName: null,
        companyFiles: [],
      };
      return { status: 200, jsonBody: body };
    }

    const files = (await response.json()) as MyobCompanyFile[];
    const configured = companyFileId
      ? files.find((file) => file.Id === companyFileId) ?? null
      : null;

    const body: TestResponse = {
      ok: true,
      message: companyFileId
        ? configured
          ? `Connected — ${files.length} company file(s), configured file found.`
          : `Connected — ${files.length} company file(s), but MYOB_COMPANY_FILE_ID was not in the list.`
        : `Connected — ${files.length} company file(s). MYOB_COMPANY_FILE_ID is not set.`,
      configStatus,
      linked: true,
      configuredFileId: companyFileId || null,
      configuredFileFound: Boolean(configured),
      configuredFileName: configured?.Name ?? null,
      companyFiles: files,
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
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
