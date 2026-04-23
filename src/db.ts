import { Connection, Request } from "tedious";

export interface SqlRow {
  [key: string]: any;
}

export interface SqlParam {
  name: string;
  type: any;
  value: any;
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

export async function createServiceConnection(): Promise<Connection> {
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

  const { access_token } = (await resp.json()) as { access_token: string };
  return createConnection(access_token);
}

export function createConnection(token: string): Promise<Connection> {
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
  params?: { name: string; type: any; value: any }[]
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
        request.addParameter(param.name, param.type, param.value);
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
