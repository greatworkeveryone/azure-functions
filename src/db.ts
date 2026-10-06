import { Connection, Request } from "tedious";

export interface SqlRow {
  [key: string]: any;
}

export interface SqlParam {
  name: string;
  type: any;
  value: any;
  /** Tedious parameter options — e.g. `{ precision: 10, scale: 2 }` for
   *  DECIMAL columns. Without this, tedious defaults Decimal to scale 0
   *  and silently truncates fractional values. */
  options?: { precision?: number; scale?: number; length?: number };
}

/**
 * Build a parameterized SET clause + params for an UPDATE.
 *
 * Security property: the loop iterates `Object.keys(allowlist)`, NOT
 * `Object.keys(fields)`. Any `fields` key that is not a compile-time
 * allowlist entry is silently dropped. That means a handler can pass
 * `body` straight through without risk of an attacker writing
 * `{ "Amount; DROP TABLE Jobs --": 1 }` into a SQL column name.
 *
 * - `undefined` field values are skipped entirely (column untouched).
 * - `null` field values are written as SQL NULL.
 * - Returns `null` when no allowlisted field was provided, so callers
 *   can short-circuit with a 400 "no fields to update".
 *
 * @example
 *   const update = buildUpdateSet(
 *     { Amount: TYPES.Decimal, Notes: TYPES.NVarChar },
 *     { Amount, Notes },
 *   );
 *   if (!update) return { status: 400, ... };
 *   await executeQuery(
 *     conn,
 *     `UPDATE Payments SET ${update.setClause} WHERE PaymentID = @Id`,
 *     [{ name: "Id", type: TYPES.Int, value: PaymentID }, ...update.params],
 *   );
 */
export function buildUpdateSet<K extends string>(
  allowlist: Record<K, any>,
  fields: Partial<Record<K, unknown>>,
): { params: SqlParam[]; setClause: string } | null {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const col of Object.keys(allowlist) as K[]) {
    if (!Object.prototype.hasOwnProperty.call(fields, col)) continue;
    const value = fields[col];
    if (value === undefined) continue;
    parts.push(`${col} = @${col}`);
    params.push({ name: col, type: allowlist[col], value: value ?? null });
  }
  if (parts.length === 0) return null;
  return { params, setClause: parts.join(", ") };
}

// When LOCAL_SQL=true, skip AAD and connect with SQL username/password (Docker dev DB).
const IS_LOCAL_SQL = process.env.LOCAL_SQL === "true";

// Cache the AAD token across warm invocations. AAD tokens are valid ~1 hour;
// reusing them avoids a network round-trip + handshake on every request and
// keeps the SQL DB from being woken purely by token refreshes.
let cachedServiceToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_SKEW_MS = 60_000;

// In-flight de-dup: on a cold start or at the hourly token expiry, many
// concurrent requests can miss the cache at once. Without this, each one
// fires its own client-credential POST to Entra, which throttles a burst
// like that — and every throttled request becomes a 500. Mirrors
// _roleInflight / lookupRolesForOid in auth.ts.
let _serviceTokenInflight: Promise<string> | null = null;

/** Test-only: drop the cached service token so cases don't bleed together.
 *  Mirrors clearRoleCache() in auth.ts. */
export function clearServiceTokenCache(): void {
  cachedServiceToken = null;
  _serviceTokenInflight = null;
}

async function _fetchServiceToken(): Promise<string> {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = process.env;
  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error("Graph credentials not configured for service DB connection");
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
        scope: "https://database.windows.net/.default",
      }).toString(),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Service DB token request failed: ${resp.status} — ${text}`);
  }

  const { access_token, expires_in } = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedServiceToken = {
    value: access_token,
    expiresAt: Date.now() + expires_in * 1000,
  };
  return access_token;
}

async function getServiceToken(): Promise<string> {
  if (cachedServiceToken && cachedServiceToken.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return cachedServiceToken.value;
  }

  if (_serviceTokenInflight) return _serviceTokenInflight;

  const promise = _fetchServiceToken().finally(() => {
    _serviceTokenInflight = null;
  });
  // A failed fetch must not be cached (unchanged — _fetchServiceToken only
  // assigns cachedServiceToken on success) and must clear the in-flight
  // holder so the next request retries — the .finally() above does that
  // unconditionally, same discipline as queryRolesForOid.
  _serviceTokenInflight = promise;
  return promise;
}

export type ConnectionTokenSource = "service" | "user";

/**
 * Which identity a per-request handler connection authenticates as.
 *
 * Service by default. SQL_USER_CONNECTION=true restores the legacy per-caller
 * identity, which requires every user to have a contained database principal —
 * kept only as a rollback lever.
 */
export function requestTokenSource(): ConnectionTokenSource {
  return process.env.SQL_USER_CONNECTION === "true" ? "user" : "service";
}

export function requestConnectionToken(userToken: string): Promise<string> {
  return requestTokenSource() === "user"
    ? Promise.resolve(userToken)
    : getServiceToken();
}

// Singleton service connection — reused across invocations within the same process.
// Keeps the DB warm during active dev; auto-closes after IDLE_TIMEOUT_MS of
// inactivity so Azure serverless auto-pause can kick in (~60 min later).
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let _serviceConn: Connection | null = null;
let _serviceConnPromise: Promise<Connection> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;

function _onServiceConnReset() {
  _serviceConn = null;
  _serviceConnPromise = null;
}

function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_serviceConn) _serviceConn.close();
    // 'end' event fires → _onServiceConnReset clears the singleton
  }, IDLE_TIMEOUT_MS);
  // Don't keep the process alive just for this timer
  _idleTimer.unref?.();
}

async function _createFreshServiceConnection(): Promise<Connection> {
  const conn = IS_LOCAL_SQL
    ? await createLocalConnection()
    : await createConnection(await getServiceToken());
  conn.on("error", _onServiceConnReset);
  conn.on("end", _onServiceConnReset);
  _serviceConn = conn;
  return conn;
}

export function createServiceConnection(): Promise<Connection> {
  if (_serviceConnPromise) return _serviceConnPromise;
  _serviceConnPromise = _createFreshServiceConnection().catch((err) => {
    _serviceConnPromise = null;
    throw err;
  });
  return _serviceConnPromise;
}

export function createLocalConnection(): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const config = {
      server: process.env.SQL_SERVER!,
      authentication: {
        type: "default" as const,
        options: {
          userName: process.env.SQL_USERNAME!,
          password: process.env.SQL_PASSWORD!,
        },
      },
      options: {
        database: process.env.SQL_DATABASE!,
        encrypt: true,
        trustServerCertificate: true,
      },
    };

    const connection = new Connection(config);
    connection.on("connect", (err) => {
      if (err) reject(err);
      else resolve(connection);
    });
    connection.connect();
  });
}

export function createConnection(token: string): Promise<Connection> {
  if (IS_LOCAL_SQL) return createLocalConnection();
  return new Promise((resolve, reject) => {
    const config = {
      server: process.env.SQL_SERVER!,
      authentication: {
        type: "azure-active-directory-access-token" as const,
        options: {
          token: token,
        },
      },
      options: {
        database: process.env.SQL_DATABASE!,
        encrypt: true,
        trustServerCertificate: false,
      },
    };

    const connection = new Connection(config);

    connection.on("connect", (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(connection);
      }
    });

    connection.connect();
  });
}

/**
 * Per-request connection for HTTP handler data access.
 *
 * Authenticates as the app's service principal, NOT the caller. Authorisation
 * is enforced by requireRole against dbo.AppUsers — never by SQL grants, which
 * are uniform for every caller (no RLS, no SESSION_CONTEXT, no SUSER_NAME()
 * filtering anywhere in this repo, and server auditing is off). Connecting as
 * the caller bought nothing and meant every new user needed a database
 * principal created by hand, which silently 500'd the whole app when missed.
 *
 * Returns a FRESH connection, never the createServiceConnection() singleton:
 * a tedious Connection cannot serve concurrent Requests, and handler traffic is
 * concurrent. This keeps today's one-connection-per-request semantics exactly.
 *
 * `userToken` is used only when SQL_USER_CONNECTION=true (rollback path).
 */
export async function createRequestConnection(userToken: string): Promise<Connection> {
  if (IS_LOCAL_SQL) return createLocalConnection();
  return createConnection(await requestConnectionToken(userToken));
}

/**
 * Fresh service-principal connection for callers that have no user identity at
 * all — webhooks invoked by third parties. Unlike createServiceConnection()
 * this is NOT the singleton, so it is safe under concurrent HTTP traffic.
 * Unlike createRequestConnection() it takes no user token, so the
 * SQL_USER_CONNECTION rollback lever cannot redirect it to a caller identity
 * that does not exist.
 */
export async function createServiceRequestConnection(): Promise<Connection> {
  if (IS_LOCAL_SQL) return createLocalConnection();
  return createConnection(await getServiceToken());
}

export function executeQuery(
  connection: Connection,
  sql: string,
  params?: SqlParam[]
): Promise<SqlRow[]> {
  return new Promise((resolve, reject) => {
    const rows: SqlRow[] = [];

    const request = new Request(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });

    if (params) {
      for (const param of params) {
        request.addParameter(param.name, param.type, param.value, param.options);
      }
    }

    request.on("row", (columns: any[]) => {
      const row: SqlRow = {};
      columns.forEach((col) => {
        row[col.metadata.colName] = col.value;
      });
      rows.push(row);
    });

    connection.execSql(request);
  });
}

export function closeConnection(connection: Connection): void {
  if (connection === _serviceConn) {
    // Don't close — reset the idle timer so the connection stays warm during
    // active use but closes 10 min after the last request.
    _resetIdleTimer();
    return;
  }
  connection.close();
}

export function beginTransaction(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.beginTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function commitTransaction(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.commitTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function rollbackTransaction(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.rollbackTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
