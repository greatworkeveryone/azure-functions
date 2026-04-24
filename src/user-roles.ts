// Looks up a user's app role assignments via the Microsoft Graph API.
//
// Why Graph and not JWT claims: the bearer token sent by the frontend is a SQL
// delegation token (aud = database.windows.net). Entra does not include custom
// app-role claims in that token — roles only appear in tokens whose audience is
// the app's own client ID. Rather than requiring the frontend to send a second
// (unverified) token, the backend resolves roles itself using the user's OID,
// which is trustworthy because Azure SQL auth verifies the full token chain.
//
// Requires env vars:
//   GRAPH_TENANT_ID      — Azure AD tenant GUID
//   GRAPH_CLIENT_ID      — Service principal client ID (must have Directory.Read.All
//                          or AppRoleAssignment.ReadWrite.All on the Graph scope)
//   GRAPH_CLIENT_SECRET  — Service principal secret
//   APP_CLIENT_ID        — Client ID of the app registration where users are
//                          assigned roles (the frontend/API app registration)

interface ServicePrincipalCache {
  objectId: string;
  // Map from appRoleId GUID → role value string (e.g. "Admin", "facilities")
  roleMap: Map<string, string>;
  fetchedAt: number;
}

interface UserRolesCache {
  roles: string[];
  fetchedAt: number;
}

// Service principal info is stable — re-fetch only every 60 minutes.
const SP_TTL_MS = 60 * 60 * 1000;
// User assignments can change — re-fetch every 5 minutes.
const USER_TTL_MS = 5 * 60 * 1000;

let spCache: ServicePrincipalCache | null = null;
const userCache = new Map<string, UserRolesCache>();

async function getGraphToken(): Promise<string> {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = process.env;
  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error("Graph credentials not configured");
  }
  const resp = await fetch(
    `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: GRAPH_CLIENT_ID,
        client_secret: GRAPH_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph token request failed: ${resp.status} — ${text}`);
  }
  const { access_token } = (await resp.json()) as { access_token: string };
  return access_token;
}

async function resolveServicePrincipal(graphToken: string): Promise<ServicePrincipalCache> {
  const now = Date.now();
  if (spCache && now - spCache.fetchedAt < SP_TTL_MS) return spCache;

  const appClientId = process.env.APP_CLIENT_ID;
  if (!appClientId) throw new Error("APP_CLIENT_ID env var not set");

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${appClientId}'&$select=id,appRoles`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph servicePrincipals lookup failed: ${resp.status} — ${text}`);
  }
  const body = (await resp.json()) as {
    value: Array<{ id: string; appRoles: Array<{ id: string; value: string }> }>;
  };
  const sp = body.value[0];
  if (!sp) throw new Error(`No service principal found for appId ${appClientId}`);

  const roleMap = new Map<string, string>();
  for (const role of sp.appRoles) {
    roleMap.set(role.id, role.value);
  }

  spCache = { objectId: sp.id, roleMap, fetchedAt: now };
  return spCache;
}

/**
 * Resolve the app role names for a given user OID via Graph.
 * Results are cached per-user for USER_TTL_MS to avoid hammering Graph on
 * every request, while still picking up role changes within ~5 minutes.
 */
export async function lookupUserRoles(oid: string): Promise<string[]> {
  const now = Date.now();
  const cached = userCache.get(oid);
  if (cached && now - cached.fetchedAt < USER_TTL_MS) return cached.roles;

  const graphToken = await getGraphToken();
  const sp = await resolveServicePrincipal(graphToken);

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${oid}/appRoleAssignments?$filter=resourceId eq ${sp.objectId}&$select=appRoleId`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph appRoleAssignments lookup failed: ${resp.status} — ${text}`);
  }
  const body = (await resp.json()) as { value: Array<{ appRoleId: string }> };

  const roles: string[] = [];
  for (const assignment of body.value) {
    const name = sp.roleMap.get(assignment.appRoleId);
    // appRoleId of 00000000-… is the default "user" access — skip it
    if (name) roles.push(name);
  }

  userCache.set(oid, { roles, fetchedAt: now });
  return roles;
}
