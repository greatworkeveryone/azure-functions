// A short-lived database connection for the gateway (SC-AI1). runAi has no user
// token, only an actor, so it uses a fresh service-principal connection (never the
// shared singleton, which cannot serve concurrent requests), and gives it back
// before a model is called: no connection is held open while waiting on a provider.

import { closeConnection, createServiceRequestConnection } from "../db";
import type { Connection } from "tedious";

export async function withServiceConnection<Result>(work: (connection: Connection) => Promise<Result>): Promise<Result> {
  const connection = await createServiceRequestConnection();
  try {
    return await work(connection);
  } finally {
    closeConnection(connection);
  }
}
