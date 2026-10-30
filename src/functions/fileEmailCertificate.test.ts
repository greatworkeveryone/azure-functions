import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import * as userStore from "../comms/userSignatureStore";
import * as flags from "../features/flags";
import * as templateModule from "../intake/template";
import { executeQuery } from "../db";
import { record } from "../ledger";
import { _resetRateLimitForTests } from "../rateLimit";
import { fileEmailCertificate } from "./fileEmailCertificate";
import { storeRegisterDocument } from "./document-register";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => ({ email: "fay@randazzo.properties", name: "Fay Facilities", oid: "fay-oid" }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("../blob-storage", () => ({ downloadBlob: jest.fn(async () => Buffer.from("%PDF-1.7 original")) }));
jest.mock("../test-data", () => ({ showTestData: jest.fn(async () => false) }));
jest.mock("../comms/userSignatureStore", () => ({ findUserByOid: jest.fn(), readUserSignature: jest.fn() }));
jest.mock("../features/flags", () => ({ isFeatureEnabledForRoles: jest.fn() }));
jest.mock("../intake/template", () => ({ ...jest.requireActual("../intake/template"), loadTemplateBySlug: jest.fn() }));
jest.mock("./document-register", () => ({ storeRegisterDocument: jest.fn() }));

const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const BLOB = "email-attachments/abc/00000000-0000-4000-8000-000000000000.pdf";
const body = (over: Record<string, unknown> = {}) => ({ attachmentBlobName: BLOB, contractorId: 4, emailId: 9, expiresOn: "2027-03-01", insuranceType: "Public liability", ...over });
const post = (payload: unknown) => new HttpRequest({ body: { string: JSON.stringify(payload) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/fileEmailCertificate" });
const query = jest.mocked(executeQuery);
const store = jest.mocked(storeRegisterDocument);

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  delete process.env.CERTIFICATE_ACK_ENABLED;
  jest.mocked(flags.isFeatureEnabledForRoles).mockResolvedValue(true);
  jest.mocked(userStore.findUserByOid).mockResolvedValue({ displayName: "Fay Facilities", email: "fay@randazzo.properties", userId: 7 });
  jest.mocked(templateModule.loadTemplateBySlug).mockResolvedValue(null);
  query.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.Emails/.test(sql)) return [{ AttachmentBlobs: JSON.stringify([{ blobName: BLOB, fileName: "coc.pdf" }]), EmailID: 9, FromAddress: "sue@sparky.example", SenderVerified: 1 }];
    if (/WITH \(UPDLOCK/.test(sql)) return [];
    if (/INSERT dbo\.EmailCertificateFilings/.test(sql)) return [{ FilingId: 3 }];
    if (/FROM dbo\.Contractors/.test(sql)) return [{ ContractorName: "Sparky Pty Ltd" }];
    return [];
  });
  store.mockImplementation(async (_s, _c, _input, _file, inside) => {
    const refusal = inside ? await inside(77) : null;
    return refusal ?? { jsonBody: { documentId: 77 }, status: 201 };
  });
});

describe("fileEmailCertificate", () => {
  it("keeps the original attachment as the register document, links the email, and ledgers it", async () => {
    const response = await fileEmailCertificate(post(body({ insurer: "QBE" })), context);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({ acknowledgement: null, documentId: 77, emailId: 9, filingId: 3 });
    const [, , input, file] = store.mock.calls[0];
    expect(file.bytes.toString()).toBe("%PDF-1.7 original");
    expect(file).toMatchObject({ contentType: "application/pdf", fileName: "coc.pdf" });
    expect(input).toMatchObject({ category: "Insurance", contractorId: 4, kind: "certificate", ownerName: "Fay Facilities" });
    expect(jest.mocked(record)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "email.file_certificate", subject: { id: 9, type: "email" } }));
  });

  it("answers 404 while the flag is not enabled", async () => {
    jest.mocked(flags.isFeatureEnabledForRoles).mockResolvedValue(false);
    expect((await fileEmailCertificate(post(body()), context)).status).toBe(404);
    expect(store).not.toHaveBeenCalled();
  });

  it("refuses a file that is not an attachment of that email", async () => {
    const response = await fileEmailCertificate(post(body({ attachmentBlobName: "email-attachments/abc/ffffffff-0000-4000-8000-000000000000.pdf" })), context);
    expect(response.status).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });

  it("refuses a second filing of the same attachment", async () => {
    query.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM dbo\.Emails/.test(sql)) return [{ AttachmentBlobs: JSON.stringify([BLOB]), EmailID: 9, FromAddress: "x@y.example", SenderVerified: 1 }];
      if (/WITH \(UPDLOCK/.test(sql)) return [{ FiledByName: "Someone" }];
      return [];
    });
    const response = await fileEmailCertificate(post(body()), context);
    expect(response.status).toBe(409);
    expect(jest.mocked(record)).not.toHaveBeenCalled();
  });

  it("sends nothing unless the switch is on, and says so; the filing still stands", async () => {
    const response = await fileEmailCertificate(post(body({ acknowledge: true })), context);
    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({ acknowledgement: { status: "not_sent" } });
  });

  it("refuses the thank-you email for admin before anything is filed", async () => {
    roles = [AppRole.ADMIN];
    expect((await fileEmailCertificate(post(body({ acknowledge: true })), context)).status).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });

  it("is refused for a role outside the gate", async () => {
    roles = [AppRole.USER];
    expect((await fileEmailCertificate(post(body()), context)).status).toBe(403);
  });
});
