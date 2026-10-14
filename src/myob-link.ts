// Completing a MYOB link from the OAuth callback (MYOB N3, SEC-15). In order,
// and nothing is stored unless every step passes:
//   1. the state is consumed: single use, 10 minutes, names the admin who started
//   2. businessId (the company file MYOB says was approved) must be registered
//      in Admin → MYOB → Entities and switched on there, read or write
//      (decision 14; checked again under the token lock), and be the configured file,
//      MYOB_COMPANY_FILE_ID; with none configured it must be the file already
//      linked, and a first link records it
//   3. the code is exchanged; a token with any scope beyond the two is dropped
//   4. in one transaction under the token lock: tokens stored encrypted with the
//      MYOB user, the file and who linked, and the link ledgered (myob.link)
//   5. system.health is raised, so admin sees every link and re-link

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createServiceRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "./db";
import { newCorrelationId, record } from "./ledger";
import type { MyobActor } from "./myob-api-log";
import { exchangeCode, MyobScopeError } from "./myob-auth";
import { consumeAuthState, type AuthStateOwner } from "./myob-auth-state";
import { lockMyobTokens, readMyobAuthRow, saveLinkedTokens, type MyobAuthRow } from "./myob-auth-store";
import { isMyobFileMode, type MyobFileMode } from "./myob-company-files-store";
import { MYOB_HEALTH_SUBJECTS, raiseMyobHealth } from "./myob-health";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LinkOutcome =
  | { ok: true; businessId: string; myobUsername: string | null; relinked: boolean }
  | { ok: false; status: 400 | 409 | 500; title: string; detail: string };

function fail(status: 400 | 409 | 500, title: string, detail: string): LinkOutcome {
  return { detail, ok: false, status, title };
}

/** Refused under the token lock: nothing is stored, and the callback answers 409. */
class LinkRefusal extends Error {
  readonly title: string;
  constructor(title: string, detail: string) {
    super(detail);
    this.title = title;
  }
}

/**
 * The file's mode, or null when it isn't registered at all. Under the token
 * lock it takes the row's update lock too, so a mode change (which takes the
 * same lock in setMyobFileMode) is serialised against the link.
 */
async function fileMode(connection: Connection, businessId: string, lock = false): Promise<MyobFileMode | null> {
  const rows = await executeQuery(
    connection,
    lock
      ? `SELECT Mode FROM dbo.MyobCompanyFiles WITH (UPDLOCK, HOLDLOCK) WHERE CompanyFileId = @CompanyFileId`
      : `SELECT Mode FROM dbo.MyobCompanyFiles WHERE CompanyFileId = @CompanyFileId`,
    [{ name: "CompanyFileId", type: TYPES.NVarChar, value: businessId }],
  );
  if (!rows[0]) return null;
  return isMyobFileMode(rows[0].Mode) ? rows[0].Mode : "off";
}

/** Why this file can't be linked now, or null when it can. */
function modeRefusal(businessId: string, mode: MyobFileMode | null): { detail: string; title: string } | null {
  if (mode === null) {
    return {
      detail: `Ask the CFO to register ${businessId} in Admin → MYOB → Entities, then link again. Nothing was linked.`,
      title: "That company file is not registered with Floorplan",
    };
  }
  if (mode === "off") {
    return {
      detail: `The CFO has ${businessId} switched off in Admin → MYOB → Entities. Ask her to set it to read only or read and create, then link again. Nothing was linked.`,
      title: "That company file is switched off for Floorplan",
    };
  }
  return null;
}

/** Which file this link must be for, or null when the first link may choose. */
function expectedFile(row: MyobAuthRow | null): string | null {
  const configured = process.env.MYOB_COMPANY_FILE_ID?.trim();
  if (configured) return configured.toLowerCase();
  return row?.BusinessId ? row.BusinessId.toLowerCase() : null;
}

async function withConnection<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = await createServiceRequestConnection();
  try {
    return await work(connection);
  } finally {
    closeConnection(connection);
  }
}

async function userIdForOid(connection: Connection, oid: string): Promise<number | null> {
  const rows = await executeQuery(connection, `SELECT UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`, [
    { name: "Oid", type: TYPES.NVarChar, value: oid },
  ]);
  return (rows[0]?.UserID as number | undefined) ?? null;
}

function linkSnapshot(row: MyobAuthRow | null) {
  if (!row) return null;
  return {
    businessId: row.BusinessId,
    linkedAt: row.AuthorizedAt ? row.AuthorizedAt.toISOString() : null,
    linkedBy: row.LinkedByName ?? row.AuthorizedBy,
    myobUsername: row.MyobUsername,
  };
}

export async function completeMyobLink(input: {
  businessId: string | null;
  code: string;
  state: string;
}): Promise<LinkOutcome> {
  const owner: AuthStateOwner | null = await consumeAuthState(input.state);
  if (!owner) {
    return fail(400, "This link has expired or was already used", "Start the link again from Admin → MYOB (it is valid for 10 minutes, once).");
  }
  const businessId = input.businessId?.trim().toLowerCase() ?? "";
  if (!GUID.test(businessId)) {
    return fail(400, "MYOB did not say which company file was approved", "Nothing was linked. Start again from Admin → MYOB.");
  }
  const { mode, row } = await withConnection(async (connection) => ({
    mode: await fileMode(connection, businessId),
    row: await readMyobAuthRow(connection),
  }));
  const refused = modeRefusal(businessId, mode);
  if (refused) return fail(409, refused.title, refused.detail);
  const expected = expectedFile(row);
  if (expected && expected !== businessId) {
    return fail(409, "That is not the company file Floorplan is set up for", `MYOB approved file ${businessId}; Floorplan expects ${expected}. Nothing was linked.`);
  }

  const correlationId = newCorrelationId();
  const actor: MyobActor = { kind: "user", name: owner.name, oid: owner.oid, role: "admin" };
  let tokens;
  try {
    tokens = await exchangeCode(input.code, actor, correlationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(error instanceof MyobScopeError ? 409 : 500, "MYOB did not link", message);
  }

  let previous: MyobAuthRow | null;
  try {
    previous = await storeLink(businessId, owner, tokens, correlationId);
  } catch (error) {
    if (error instanceof LinkRefusal) return fail(409, error.title, error.message);
    throw error;
  }

  const relinked = previous !== null;
  await raiseMyobHealth(
    MYOB_HEALTH_SUBJECTS.link,
    `MYOB was ${relinked ? "re-linked" : "linked"} by ${owner.name} to company file ${businessId} as ${tokens.user?.username ?? "an unnamed MYOB user"}`,
    { businessId, correlationId, linkedBy: owner.name, myobUsername: tokens.user?.username ?? null, relinked },
  );
  return { businessId, myobUsername: tokens.user?.username ?? null, ok: true, relinked };
}

/** Stores the tokens and ledgers the link in one transaction under the token lock, re-checking the file first. */
async function storeLink(
  businessId: string,
  owner: AuthStateOwner,
  tokens: Awaited<ReturnType<typeof exchangeCode>>,
  correlationId: string,
): Promise<MyobAuthRow | null> {
  return withConnection(async (connection) => {
    await beginTransaction(connection);
    try {
      await lockMyobTokens(connection);
      const refused = modeRefusal(businessId, await fileMode(connection, businessId, true));
      if (refused) throw new LinkRefusal(refused.title, refused.detail);
      const prior = await readMyobAuthRow(connection);
      const stillExpected = expectedFile(prior);
      if (stillExpected && stillExpected !== businessId) {
        throw new LinkRefusal("That is not the company file Floorplan is set up for", `Floorplan now expects company file ${stillExpected}. Nothing was linked.`);
      }
      await saveLinkedTokens(connection, { businessId, linkedBy: owner, tokens });
      await record(connection, {
        action: "myob.link",
        actor: { kind: "user", name: owner.name, role: "admin", userId: await userIdForOid(connection, owner.oid) },
        after: { businessId, linkedBy: owner.name, myobUserUid: tokens.user?.uid ?? null, myobUsername: tokens.user?.username ?? null, scope: tokens.scope ?? null },
        before: linkSnapshot(prior),
        correlationId,
        ruleApplied: prior ? "relink" : "link",
        subject: { id: businessId, type: "myob_link" },
      });
      await commitTransaction(connection);
      return prior;
    } catch (error) {
      await rollbackTransaction(connection).catch(() => undefined);
      throw error;
    }
  });
}
