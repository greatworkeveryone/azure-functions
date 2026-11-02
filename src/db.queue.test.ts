/// <reference types="jest" />
import { Connection, Request, RequestError } from "tedious";
import { beginTransaction, commitTransaction, executeBatch, executeQuery } from "./db";

// Mirrors tedious 18: one in-flight request per connection, a second is
// rejected with EINVALIDSTATE (connection.js "Requests can only be made in the LoggedIn state").
function makeFakeConnection(failSql?: string) {
  let inFlight = false;
  const started: string[] = [];
  const invalidState = () => new RequestError("Requests can only be made in the LoggedIn state, not the SentClientRequest state", "EINVALIDSTATE");

  const run = (request: Request, rowFor?: string) => {
    if (inFlight) {
      request.callback(invalidState(), 0, []);
      return;
    }
    inFlight = true;
    started.push(String((request as any).sqlTextOrProcedure));
    setImmediate(() => {
      inFlight = false;
      if ((request as any).sqlTextOrProcedure === failSql) {
        request.callback(new RequestError("boom", "EREQUEST"), 0, []);
        return;
      }
      if (rowFor) request.emit("row", [{ metadata: { colName: "v" }, value: rowFor }]);
      request.callback(undefined, 1, []);
    });
  };

  const tx = (cb: (err?: Error | null) => void) => {
    if (inFlight) {
      cb(invalidState());
      return;
    }
    inFlight = true;
    setImmediate(() => {
      inFlight = false;
      cb(null);
    });
  };

  const conn = {
    execSql: (request: Request) => run(request, String((request as any).sqlTextOrProcedure)),
    execSqlBatch: (request: Request) => run(request),
    beginTransaction: tx,
    commitTransaction: tx,
    rollbackTransaction: tx,
  };
  return { conn: conn as unknown as Connection, started };
}

describe("per-connection request queue", () => {
  it("runs two concurrent executeQuery calls in order without EINVALIDSTATE", async () => {
    const { conn, started } = makeFakeConnection();
    const [a, b] = await Promise.all([executeQuery(conn, "SELECT 1"), executeQuery(conn, "SELECT 2")]);
    expect(a).toEqual([{ v: "SELECT 1" }]);
    expect(b).toEqual([{ v: "SELECT 2" }]);
    expect(started).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not let a rejected query block the next one", async () => {
    const { conn } = makeFakeConnection("SELECT bad");
    const first = executeQuery(conn, "SELECT bad");
    const second = executeQuery(conn, "SELECT 2");
    await expect(first).rejects.toMatchObject({ code: "EREQUEST" });
    await expect(second).resolves.toEqual([{ v: "SELECT 2" }]);
  });

  it("queues executeBatch and transaction calls behind an in-flight query", async () => {
    const { conn, started } = makeFakeConnection();
    await Promise.all([executeQuery(conn, "SELECT 1"), executeBatch(conn, "SET XACT_ABORT ON"), beginTransaction(conn), executeQuery(conn, "SELECT 2"), commitTransaction(conn)]);
    expect(started).toEqual(["SELECT 1", "SET XACT_ABORT ON", "SELECT 2"]);
  });

  it("keeps separate connections independent", async () => {
    const a = makeFakeConnection();
    const b = makeFakeConnection();
    await expect(Promise.all([executeQuery(a.conn, "SELECT 1"), executeQuery(b.conn, "SELECT 1")])).resolves.toHaveLength(2);
  });
});
