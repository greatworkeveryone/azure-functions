import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { forbiddenResponse, rolesForRequest } from "../auth";
import { usageScopeFor, type UsageScope } from "./scope";

/** The caller's scope for the usage analytics, or a 403 when they have none. */
export async function usageScopeOf(request: HttpRequest): Promise<{ scope: UsageScope } | { response: HttpResponseInit }> {
  const scope = usageScopeFor(await rolesForRequest(request));
  return scope === null ? { response: forbiddenResponse("Usage analytics are for admin, directors and the CFO.") } : { scope };
}

/** For every view except Finance: only admin and directors. The CFO is held to the Finance view, whatever the role gate says. */
export async function refuseUnlessAllScope(request: HttpRequest): Promise<HttpResponseInit | null> {
  const result = await usageScopeOf(request);
  if ("response" in result) return result.response;
  return result.scope === "all" ? null : forbiddenResponse("This view is for admin and directors. The CFO sees Finance usage.");
}
