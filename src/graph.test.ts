/// <reference types="jest" />
jest.mock("./blob-storage", () => ({
  uploadBlob: jest
    .fn()
    .mockImplementation(async (_buf: Buffer, name: string, _type: string, prefix: string) => ({
      blobName: `${prefix}/${name}`,
    })),
}));

import { graphFetchEmails } from "./graph";

const blob = require("./blob-storage") as { uploadBlob: jest.Mock };

const MESSAGES = [
  { hasAttachments: true, id: "g-old", internetMessageId: "<old@x>", receivedDateTime: "2026-10-06T01:00:00Z", subject: "Old" },
  { hasAttachments: true, id: "g-new", internetMessageId: "<new@x>", receivedDateTime: "2026-10-06T01:00:00Z", subject: "New" },
];

function respond(body: unknown): unknown {
  return { arrayBuffer: async () => new ArrayBuffer(4), json: async () => body, ok: true, status: 200, text: async () => "" };
}

// Token, message list, attachment list and attachment bytes, routed by URL.
function routeGraph(messages: unknown[] = MESSAGES): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/")) return respond({ access_token: "graph-tok" });
    if (url.includes("/attachments?")) {
      return respond({
        value: [{ "@odata.type": "#microsoft.graph.fileAttachment", contentType: "application/pdf", id: "a1", name: "quote.pdf" }],
      });
    }
    if (url.endsWith("/$value")) return respond({});
    if (url.includes("/mailFolders/Inbox/messages")) return respond({ value: messages });
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
});

describe("graphFetchEmails → already-stored messages", () => {
  it("drops a known message before fetching its attachments", async () => {
    const fetchMock = routeGraph();

    const emails = await graphFetchEmails("inbox@example.test", "2026-10-06T01:00:00.000Z", new Set(["<old@x>"]));

    expect(emails.map((e) => e.internetMessageId)).toEqual(["<new@x>"]);
    const urls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u) => u.includes("/messages/g-old/"))).toBe(false);
  });

  it("still downloads and uploads attachments for a new message", async () => {
    routeGraph();

    const emails = await graphFetchEmails("inbox@example.test", "2026-10-06T01:00:00.000Z", new Set(["<old@x>"]));

    expect(emails[0].attachmentBlobNames).toEqual([
      { blobName: "email-attachments/g-new/quote.pdf", fileName: "quote.pdf" },
    ]);
    expect(blob.uploadBlob).toHaveBeenCalledTimes(1);
  });
});

describe("graphFetchEmails → sender authentication", () => {
  const ORG_ENV = process.env.ORG_EMAIL_DOMAINS;
  afterEach(() => {
    if (ORG_ENV === undefined) delete process.env.ORG_EMAIL_DOMAINS;
    else process.env.ORG_EMAIL_DOMAINS = ORG_ENV;
  });

  it("selects internetMessageHeaders on the message list", async () => {
    const fetchMock = routeGraph();

    await graphFetchEmails("inbox@example.test");

    const listUrl = fetchMock.mock.calls
      .map((c: unknown[]) => new URL(String(c[0])))
      .find((u: URL) => u.pathname.endsWith("/mailFolders/Inbox/messages"));
    expect(listUrl?.searchParams.get("$select")?.split(",")).toContain("internetMessageHeaders");
  });

  it("maps the headers to senderAuthenticated + authenticationResults", async () => {
    process.env.ORG_EMAIL_DOMAINS = "randazzo.properties";
    const pass = "spf=pass smtp.mailfrom=contractor.com.au; dkim=pass header.d=contractor.com.au;dmarc=pass action=none header.from=contractor.com.au";
    routeGraph([
      {
        from: { emailAddress: { address: "q@contractor.com.au", name: "Q" } },
        hasAttachments: false,
        id: "g-ext",
        internetMessageHeaders: [{ name: "Authentication-Results", value: pass }],
        internetMessageId: "<ext@x>",
      },
      {
        from: { emailAddress: { address: "carlo@randazzo.properties", name: "Carlo" } },
        hasAttachments: false,
        id: "g-int",
        internetMessageHeaders: [{ name: "X-MS-Exchange-Organization-AuthAs", value: "Internal" }],
        internetMessageId: "<int@x>",
      },
      {
        from: { emailAddress: { address: "carlo@randazzo.properties", name: "Carlo" } },
        hasAttachments: false,
        id: "g-none",
        internetMessageId: "<none@x>",
      },
    ]);

    const emails = await graphFetchEmails("inbox@example.test");

    expect(emails.map((e) => [e.internetMessageId, e.senderAuthenticated, e.authenticationResults])).toEqual([
      ["<ext@x>", true, `Authentication-Results: ${pass}`],
      ["<int@x>", true, "X-MS-Exchange-Organization-AuthAs: Internal"],
      ["<none@x>", false, null],
    ]);
  });
});
