import { Connection, Request } from "tedious";

export interface SqlRow {
  [key: string]: any;
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
