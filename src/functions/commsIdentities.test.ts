import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import type { AdminIdentity } from "../comms/identityStore";
import * as identityStore from "../comms/identityStore";
import { _resetRateLimitForTests } from "../rateLimit";
import { getMySignature } from "./getMySignature";
import { listCommsIdentities } from "./listCommsIdentities";
import { manageCommsIdentities } from "./manageCommsIdentities";
import { updateMySignature } from "./updateMySignature";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ACCOUNTS];
let token: string | null = "token";
let email = "fay@randazzo.properties";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => (token ? { email, name: "Fay Facilities", oid: "fay-oid" } : null),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../comms/identityStore", () => ({
  ...jest.requireActual("../comms/identityStore"),
  findUserById: jest.fn(),
  findUserByOid: jest.fn(),
  insertIdentity: jest.fn(),
  listIdentities: jest.fn(),
  readIdentity: jest.fn(),
  readUserSignature: jest.fn(),
  setIdentityArchived: jest.fn(),
  updateIdentity: jest.fn(),
  writeUserSignature: jest.fn(),
}));

const store = jest.mocked(identityStore);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const get = () => new HttpRequest({ method: "GET", url: "http://localhost/api/x" });
const post = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/x" });

const identity = (over: Partial<AdminIdentity> = {}): AdminIdentity => ({
  address: "accounts@randazzo.properties", allowedRoles: [AppRole.ACCOUNTS], archivedAt: null, archivedBy: null, createdAt: "2026-10-24T00:00:00.000Z",
  createdBy: "Will", displayName: "Randazzo Accounts", identityId: 1, isActive: true, rowVersion: "0000000000000A01",
  signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: null }, teamLabel: "Accounts", updatedAt: null, updatedBy: null,
  ...over,
});
const FORM = { address: "Accounts@Randazzo.Properties", allowedRoles: ["accounts", "accounts_manager"], displayName: "Randazzo Accounts", isActive: true, signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" }, teamLabel: "Accounts" };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.ACCOUNTS];
  token = "token";
  email = "fay@randazzo.properties";
  store.findUserByOid.mockResolvedValue({ displayName: "Fay Facilities", email: "fay@randazzo.properties", userId: 7 });
  store.readUserSignature.mockResolvedValue({ jobTitle: "Accounts officer", phone: "08 8900 0000", updatedAt: null });
});

describe("listCommsIdentities", () => {
  beforeEach(() => {
    store.listIdentities.mockResolvedValue([
      identity(),
      identity({ address: "facilities@randazzo.properties", allowedRoles: [AppRole.FACILITIES], identityId: 2 }),
      identity({ address: "old@randazzo.properties", identityId: 3, isActive: false }),
    ]);
  });

  it("offers only the active identities the role may use, with their team signatures, plus the person's own address", async () => {
    const response = await listCommsIdentities(get(), context);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { identities: { address: string; identityId: number }[]; own: { address: string; available: boolean; signature: { lines: string[] } } };
    expect(body.identities.map((entry) => entry.identityId)).toEqual([1]);
    expect(body.own).toMatchObject({ address: "fay@randazzo.properties", available: true, signature: { lines: ["Fay Facilities", "Accounts officer"] } });
    expect(JSON.stringify(body)).not.toContain("rowVersion");
  });

  it("says the own address isn't available when it is off the company domain", async () => {
    email = "fay@gmail.com";
    const body = (await listCommsIdentities(get(), context)).jsonBody as { own: { available: boolean } };
    expect(body.own.available).toBe(false);
  });

  it("shows a director every operational identity and a facilities officer only theirs", async () => {
    roles = [AppRole.DIRECTOR];
    expect(((await listCommsIdentities(get(), context)).jsonBody as { identities: unknown[] }).identities).toHaveLength(2);
    roles = [AppRole.FACILITIES];
    expect(((await listCommsIdentities(get(), context)).jsonBody as { identities: { identityId: number }[] }).identities.map((entry) => entry.identityId)).toEqual([2]);
  });

  it.each([[AppRole.USER, 403], [AppRole.ADMIN, 403]])("refuses %s (%s)", async (role, status) => {
    roles = [role];
    expect((await listCommsIdentities(get(), context)).status).toBe(status);
  });

  it("refuses a request with no token", async () => {
    token = null;
    expect((await listCommsIdentities(get(), context)).status).toBe(401);
  });
});

describe("manageCommsIdentities", () => {
  beforeEach(() => {
    roles = [AppRole.ADMIN];
  });

  it.each([AppRole.DIRECTOR, AppRole.CFO, AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES, AppRole.USER])("is admin only: refuses %s", async (role) => {
    roles = [role];
    expect((await manageCommsIdentities(post({ action: "list" }), context)).status).toBe(403);
    expect(store.listIdentities).not.toHaveBeenCalled();
  });

  it("refuses no token and a bad body", async () => {
    token = null;
    expect((await manageCommsIdentities(post({ action: "list" }), context)).status).toBe(401);
    token = "token";
    expect((await manageCommsIdentities(post("not json"), context)).status).toBe(400);
    expect((await manageCommsIdentities(post({ action: "delete" }), context)).status).toBe(400);
  });

  it("lists, with archived ones only when asked", async () => {
    store.listIdentities.mockResolvedValue([identity()]);
    const response = await manageCommsIdentities(post({ action: "list", includeArchived: true }), context);
    expect(response.status).toBe(200);
    expect(store.listIdentities).toHaveBeenCalledWith(expect.anything(), true);
    expect((response.jsonBody as { identities: AdminIdentity[] }).identities[0].rowVersion).toBe("0000000000000A01");
  });

  it("creates an identity, cleaning the address and stamping who made it", async () => {
    store.insertIdentity.mockResolvedValue(5);
    store.readIdentity.mockResolvedValue(identity({ identityId: 5 }));
    const response = await manageCommsIdentities(post({ action: "create", ...FORM }), context);
    expect(response.status).toBe(201);
    expect(store.insertIdentity).toHaveBeenCalledWith(
      expect.anything(),
      { address: "accounts@randazzo.properties", allowedRoles: ["accounts", "accounts_manager"], displayName: "Randazzo Accounts", isActive: true, signature: { email: "accounts@randazzo.properties", lines: ["Accounts team"], phone: "08 8900 1111" }, teamLabel: "Accounts" },
      "Fay Facilities",
    );
  });

  it.each([
    ["an address off the company domain", { address: "boss@gmail.com" }],
    ["no roles", { allowedRoles: [] }],
    ["the user role", { allowedRoles: ["user"] }],
    ["the admin role", { allowedRoles: ["admin"] }],
    ["an unknown role", { allowedRoles: ["ceo"] }],
    ["a blank name", { displayName: " " }],
    ["a signature with HTML", { signature: { lines: ["<b>x</b>"] } }],
    ["a signature with no lines", { signature: { lines: [] } }],
    ["a signature carrying another key", { signature: { lines: ["ok"], html: "<p>x</p>" } }],
    ["no signature", { signature: undefined }],
    ["an unknown field", { colour: "red" }],
    ["a non-boolean isActive", { isActive: "yes" }],
  ])("refuses %s", async (_name, over) => {
    const response = await manageCommsIdentities(post({ action: "create", ...FORM, ...over }), context);
    expect(response.status).toBe(400);
    expect(store.insertIdentity).not.toHaveBeenCalled();
  });

  it("answers 409 for an address already in use", async () => {
    store.insertIdentity.mockRejectedValue(Object.assign(new Error("dup"), { number: 2601 }));
    expect((await manageCommsIdentities(post({ action: "create", ...FORM }), context)).status).toBe(409);
  });

  it("updates with the version it was made from", async () => {
    store.updateIdentity.mockResolvedValue("ok");
    store.readIdentity.mockResolvedValue(identity());
    const response = await manageCommsIdentities(post({ action: "update", identityId: 1, rowVersion: "0000000000000A01", ...FORM }), context);
    expect(response.status).toBe(200);
    expect(store.updateIdentity).toHaveBeenCalledWith(expect.anything(), 1, "0000000000000A01", expect.objectContaining({ address: "accounts@randazzo.properties" }), "Fay Facilities");
  });

  it("answers 409 with the identity as it stands when the version is stale", async () => {
    store.updateIdentity.mockResolvedValue("stale");
    store.readIdentity.mockResolvedValue(identity({ displayName: "Changed by someone" }));
    const response = await manageCommsIdentities(post({ action: "update", identityId: 1, rowVersion: "0000000000000A00", ...FORM }), context);
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ current: { displayName: "Changed by someone" } });
  });

  it("answers 404 for one that is gone, and refuses an edit with no version", async () => {
    store.updateIdentity.mockResolvedValue("missing");
    store.readIdentity.mockResolvedValue(null);
    expect((await manageCommsIdentities(post({ action: "update", identityId: 9, rowVersion: "0000000000000A01", ...FORM }), context)).status).toBe(404);
    expect((await manageCommsIdentities(post({ action: "update", identityId: 1, ...FORM }), context)).status).toBe(400);
    expect((await manageCommsIdentities(post({ action: "archive", identityId: 1, rowVersion: "xyz" }), context)).status).toBe(400);
  });

  it("archives and restores, never deletes", async () => {
    store.setIdentityArchived.mockResolvedValue("ok");
    store.readIdentity.mockResolvedValue(identity({ archivedAt: "2026-10-24T01:00:00.000Z" }));
    expect((await manageCommsIdentities(post({ action: "archive", identityId: 1, rowVersion: "0000000000000A01" }), context)).status).toBe(200);
    expect(store.setIdentityArchived).toHaveBeenLastCalledWith(expect.anything(), 1, "0000000000000A01", true, "Fay Facilities");
    expect((await manageCommsIdentities(post({ action: "restore", identityId: 1, rowVersion: "0000000000000A01" }), context)).status).toBe(200);
    expect(store.setIdentityArchived).toHaveBeenLastCalledWith(expect.anything(), 1, "0000000000000A01", false, "Fay Facilities");
  });
});

describe("getMySignature", () => {
  it("returns the person's own title and phone and the signature as it will print", async () => {
    const body = (await getMySignature(get(), context)).jsonBody as Record<string, unknown>;
    expect(body).toMatchObject({ emailShown: true, jobTitle: "Accounts officer", name: "Fay Facilities", phone: "08 8900 0000", userId: 7 });
    expect(body.signature).toEqual({ email: "fay@randazzo.properties", lines: ["Fay Facilities", "Accounts officer"], phone: "08 8900 0000" });
  });

  it("works for a person with no Floorplan row, with no title or phone", async () => {
    store.findUserByOid.mockResolvedValue(null);
    const body = (await getMySignature(get(), context)).jsonBody as { signature: { lines: string[] }; userId: number | null };
    expect(body.userId).toBeNull();
    expect(body.signature.lines).toEqual(["Fay Facilities"]);
  });

  it("refuses a request with no token, and a person with no role", async () => {
    token = null;
    expect((await getMySignature(get(), context)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await getMySignature(get(), context)).status).toBe(403);
  });
});

describe("updateMySignature", () => {
  it("saves the title and phone for the caller", async () => {
    const response = await updateMySignature(post({ jobTitle: "Accounts manager", phone: "0400 000 000" }), context);
    expect(response.status).toBe(200);
    expect(store.writeUserSignature).toHaveBeenCalledWith(expect.anything(), 7, { jobTitle: "Accounts manager", phone: "0400 000 000" }, "Fay Facilities");
  });

  it("clears them when sent blank", async () => {
    await updateMySignature(post({ jobTitle: "", phone: "" }), context);
    expect(store.writeUserSignature).toHaveBeenCalledWith(expect.anything(), 7, { jobTitle: null, phone: null }, "Fay Facilities");
  });

  it.each([
    ["signature text", { jobTitle: "x", phone: "", signature: "Kind regards, the CEO" }],
    ["a sender name", { jobTitle: "x", phone: "", name: "Someone Else" }],
    ["an email address", { jobTitle: "x", phone: "", email: "ceo@randazzo.properties" }],
    ["markup in the title", { jobTitle: "<b>Boss</b>", phone: "" }],
    ["a bad phone", { jobTitle: "x", phone: "call me" }],
    ["a title that is too long", { jobTitle: "x".repeat(81), phone: "" }],
  ])("refuses %s", async (_name, body) => {
    expect((await updateMySignature(post(body), context)).status).toBe(400);
    expect(store.writeUserSignature).not.toHaveBeenCalled();
  });

  it("refuses another person's signature to anyone but an admin", async () => {
    const response = await updateMySignature(post({ jobTitle: "Boss", phone: "", userId: 99 }), context);
    expect(response.status).toBe(403);
    expect(store.writeUserSignature).not.toHaveBeenCalled();
  });

  it("lets an admin edit another person's, and says so when there is no such user", async () => {
    roles = [AppRole.ADMIN];
    store.findUserById.mockResolvedValue({ displayName: "Gus", email: "gus@randazzo.properties", userId: 99 });
    expect((await updateMySignature(post({ jobTitle: "Boss", phone: "", userId: 99 }), context)).status).toBe(200);
    expect(store.writeUserSignature).toHaveBeenCalledWith(expect.anything(), 99, { jobTitle: "Boss", phone: null }, "Fay Facilities");
    store.findUserById.mockResolvedValue(null);
    expect((await updateMySignature(post({ jobTitle: "Boss", phone: "", userId: 100 }), context)).status).toBe(404);
  });

  it("accepts the caller's own userId, and says so when there is no Floorplan user to save for", async () => {
    expect((await updateMySignature(post({ jobTitle: "x", phone: "", userId: 7 }), context)).status).toBe(200);
    store.findUserByOid.mockResolvedValue(null);
    expect((await updateMySignature(post({ jobTitle: "x", phone: "" }), context)).status).toBe(404);
  });

  it("refuses no token, no role and a body that isn't JSON", async () => {
    expect((await updateMySignature(post("nope"), context)).status).toBe(400);
    roles = [];
    expect((await updateMySignature(post({ jobTitle: "x", phone: "" }), context)).status).toBe(403);
    token = null;
    expect((await updateMySignature(post({ jobTitle: "x", phone: "" }), context)).status).toBe(401);
  });

  it("reports a failed save without the database's words", async () => {
    store.writeUserSignature.mockRejectedValue(new Error("Violation of PRIMARY KEY on dbo.UserSignatures"));
    const response = await updateMySignature(post({ jobTitle: "x", phone: "" }), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("PRIMARY KEY");
  });
});
