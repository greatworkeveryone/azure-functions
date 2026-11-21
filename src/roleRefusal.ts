import type { HttpRequest, HttpResponseInit } from "@azure/functions";

// No dependencies, so a test that mocks ./auth still gets the real refusal and the ledger can read its detail.

// The wording a person sees when their role is not enough. What the route needed and what they
// have goes to the server log and the refusal ledger, never into the response body.
export const ROLE_REFUSAL_MESSAGE = "Your role can't do this.";

const _gateDetails = new WeakMap<object, string>();

/** The server-side detail behind a role refusal built by `roleForbiddenResponse`, for the ledger. */
export function roleRefusalDetail(response: HttpResponseInit): string | undefined {
  return _gateDetails.get(response);
}

export function roleForbiddenResponse(detail: string, request?: HttpRequest): HttpResponseInit {
  let route = "";
  try {
    route = request ? ` ${request.method} ${new URL(request.url).pathname}` : "";
  } catch {
    route = "";
  }
  console.warn(`[auth] 403${route}: ${detail}`);
  const response: HttpResponseInit = { status: 403, jsonBody: { error: ROLE_REFUSAL_MESSAGE } };
  _gateDetails.set(response, detail);
  return response;
}

