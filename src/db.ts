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

async function getServiceToken(): Promise<string> {
  if (cachedServiceToken && cachedServiceToken.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return cachedServiceToken.value;
  }

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
