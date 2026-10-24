/// <reference types="jest" />
jest.mock("./blob-storage", () => ({
  uploadBlob: jest
    .fn()
    .mockImplementation(async (_buf: Buffer, name: string, _type: string, prefix: string) => ({
      blobName: `${prefix}/${name}`,
    })),
}));

import { clearGraphTokenCache, getGraphToken, graphFetchEmails, graphSendMail, graphSendReply } from "./graph";
import { NOT_A_RECORD, TestDataEgressError } from "./test-data";

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
  clearGraphTokenCache();
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

describe("graphFetchEmails → attachment retry", () => {
  function failFirst(match: (url: string) => boolean, status: number): jest.Mock {
    const fetchMock = routeGraph([MESSAGES[1]]);
    const route = fetchMock.getMockImplementation() as (input: string) => Promise<unknown>;
    let failed = false;
    fetchMock.mockImplementation(async (input: string) => {
      if (!failed && match(String(input))) {
        failed = true;
        return { json: async () => ({}), ok: false, status, text: async () => "busy" };
      }
      return route(input);
    });
    return fetchMock;
  }

  it("retries the attachment list once when Graph answers 503", async () => {
    failFirst((url) => url.includes("/attachments?"), 503);
    const [email] = await graphFetchEmails("inbox@example.test");
    expect(email.attachmentBlobNames).toHaveLength(1);
  });

  it("retries an attachment download once when Graph answers 429", async () => {
    failFirst((url) => url.endsWith("/$value"), 429);
    const [email] = await graphFetchEmails("inbox@example.test");
    expect(email.attachmentBlobNames).toHaveLength(1);
  });

  it("does not retry a 404", async () => {
    const fetchMock = failFirst((url) => url.includes("/attachments?"), 404);
    const [email] = await graphFetchEmails("inbox@example.test");
    expect(email.attachmentBlobNames).toEqual([]);
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("/attachments?"))).toHaveLength(1);
  });
});

describe("graph send helpers refuse test records (D9)", () => {
  beforeEach(() => {
    process.env.GRAPH_SENDER_EMAIL = "floorplan@example.com";
  });

  it("graphSendMail throws before asking for a token when the mail is about a test record", async () => {
    const fetchMock = routeGraph();
    await expect(graphSendMail({ isTest: true }, "a@example.com", "Subject", "Body")).rejects.toBeInstanceOf(
      TestDataEgressError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("graphSendReply throws the same way", async () => {
    const fetchMock = routeGraph();
    await expect(graphSendReply({ isTest: true }, "a@example.com", "Subject", "Body", null)).rejects.toThrow(
      "Not sent: test record",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a real record's mail, and mail that isn't about a record", async () => {
    const fetchMock = jest.fn().mockImplementation(async (input: string) =>
      String(input).startsWith("https://login.microsoftonline.com/")
        ? respond({ access_token: "graph-tok" })
        : { ok: true, status: 202, text: async () => "" },
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await graphSendMail({ isTest: false }, "a@example.com", "Subject", "Body");
    await graphSendMail(NOT_A_RECORD, "a@example.com", "Feedback", "Body");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sendMail"))).toHaveLength(2);
  });
});

describe("getGraphToken cache", () => {
  function tokenEndpoint(expiresIn = 3600): jest.Mock {
    let n = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      n += 1;
      return { json: async () => ({ access_token: `tok-${n}`, expires_in: expiresIn }), ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  afterEach(() => jest.useRealTimers());

  it("reuses a token until shortly before it expires", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-23T00:00:00Z") });
    const fetchMock = tokenEndpoint(3600);
    expect(await getGraphToken()).toBe("tok-1");
    expect(await getGraphToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Inside the 60 s refresh skew: fetch a new one.
    jest.setSystemTime(new Date("2026-10-23T00:59:30Z"));
    expect(await getGraphToken()).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent misses into one token request", async () => {
    const fetchMock = tokenEndpoint();
    const tokens = await Promise.all([getGraphToken(), getGraphToken(), getGraphToken()]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws, caching nothing, when the response has no access_token", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ access_token: "", expires_in: 3600 }), ok: true, status: 200, text: async () => "" })
      .mockResolvedValueOnce({ json: async () => ({ expires_in: 3600 }), ok: true, status: 200, text: async () => "" })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "tok-ok", expires_in: 3600 }), ok: true, status: 200, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(getGraphToken()).rejects.toThrow(/no access_token/);
    await expect(getGraphToken()).rejects.toThrow(/no access_token/);
    await expect(getGraphToken()).resolves.toBe("tok-ok");
  });

  it("a clear during a fetch stops that fetch repopulating the cache", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      n += 1;
      const value = `tok-${n}`;
      if (n === 1) await gate;
      return { json: async () => ({ access_token: value, expires_in: 3600 }), ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const stale = getGraphToken();
    await Promise.resolve();
    clearGraphTokenCache();
    release();
    expect(await stale).toBe("tok-1");
    // The stale fetch finished after the clear, so it was not cached.
    expect(await getGraphToken()).toBe("tok-2");
    expect(await getGraphToken()).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure: the next call asks again", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ json: async () => ({}), ok: false, status: 503, text: async () => "busy" })
      .mockResolvedValueOnce({ json: async () => ({ access_token: "tok-ok", expires_in: 3600 }), ok: true, status: 200, text: async () => "" });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(getGraphToken()).rejects.toThrow(/503/);
    await expect(getGraphToken()).resolves.toBe("tok-ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("sendMail on a stale token", () => {
  // Token endpoint hands out tok-1, tok-2…; sendMail answers from `statuses` in order.
  function route(statuses: number[]): jest.Mock {
    let tokens = 0;
    const fetchMock = jest.fn().mockImplementation(async (input: string) => {
      if (String(input).startsWith("https://login.microsoftonline.com/")) {
        tokens += 1;
        return { json: async () => ({ access_token: `tok-${tokens}`, expires_in: 3600 }), ok: true, status: 200, text: async () => "" };
      }
      const status = statuses.shift() ?? 202;
      return { json: async () => ({}), ok: status < 300, status, text: async () => `status ${status}` };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const sends = (fetchMock: jest.Mock): unknown[][] => fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith("/sendMail"));
  const auth = (call: unknown[]): string => ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

  beforeEach(() => {
    process.env.GRAPH_SENDER_EMAIL = "floorplan@example.test";
  });

  it("graphSendMail: on 401 refetches the token and sends once more", async () => {
    const fetchMock = route([401, 202]);
    await graphSendMail(NOT_A_RECORD, "a@example.test", "Hi", "Body");
    expect(sends(fetchMock).map(auth)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("graphSendReply: on 401 refetches the token and sends once more", async () => {
    const fetchMock = route([401, 202]);
    await expect(graphSendReply(NOT_A_RECORD, "a@example.test", "Hi", "Body", null)).resolves.toMatch(/^graph-sent-/);
    expect(sends(fetchMock).map(auth)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("throws when the retry is refused too, after exactly one retry", async () => {
    const fetchMock = route([401, 401]);
    await expect(graphSendMail(NOT_A_RECORD, "a@example.test", "Hi", "Body")).rejects.toThrow(/sendMail failed: 401/);
    expect(sends(fetchMock)).toHaveLength(2);
  });

  it.each([403, 500])("does not retry a %i", async (status) => {
    const fetchMock = route([status, 202]);
    await expect(graphSendMail(NOT_A_RECORD, "a@example.test", "Hi", "Body")).rejects.toThrow(new RegExp(`sendMail failed: ${status}`));
    await expect(graphSendReply(NOT_A_RECORD, "a@example.test", "Hi", "Body", null)).resolves.toBeDefined();
    expect(sends(fetchMock)).toHaveLength(2);
  });
});

describe("graphFetchEmails → inbound attachment hygiene", () => {
  const PDF = Buffer.from("%PDF-1.4");
  const fileAtt = (id: string, name: string, contentType: string, size: number) => ({
    "@odata.type": "#microsoft.graph.fileAttachment", contentType, id, name, size,
  });
  // Serves the given attachment list and per-id bytes.
  function routeAttachments(list: unknown[], bytes: Record<string, Buffer>): jest.Mock {
    const fetchMock = jest.fn().mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.startsWith("https://login.microsoftonline.com/")) return respond({ access_token: "graph-tok" });
      if (url.includes("/attachments?")) return respond({ value: list });
      if (url.endsWith("/$value")) {
        const id = url.split("/attachments/")[1].split("/")[0];
        const b = bytes[id];
        return { ...(respond({}) as object), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
      }
      if (url.includes("/mailFolders/Inbox/messages")) return respond({ value: [MESSAGES[1]] });
      throw new Error(`unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const run = (): Promise<unknown> => graphFetchEmails("inbox@example.test", "2026-10-06T01:00:00.000Z", new Set());
  const typesStored = (): string[] => blob.uploadBlob.mock.calls.map((c: unknown[]) => c[2] as string);

  it("skips an attachment whose declared size is over the cap without downloading it", async () => {
    const fetchMock = routeAttachments([fileAtt("big", "big.pdf", "application/pdf", 26 * 1024 * 1024)], {});
    await run();
    expect(blob.uploadBlob).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).endsWith("/$value"))).toBe(false);
  });

  it("skips an attachment whose real bytes exceed the cap even if size lied", async () => {
    routeAttachments([fileAtt("liar", "x.pdf", "application/pdf", 10)], { liar: Buffer.alloc(26 * 1024 * 1024) });
    await run();
    expect(blob.uploadBlob).not.toHaveBeenCalled();
  });

  it("stores SVG, HTML and unknown types as octet-stream instead of dropping them", async () => {
    routeAttachments(
      [
        fileAtt("a", "a.svg", "image/svg+xml; charset=utf-8", 5),
        fileAtt("b", "b.html", "text/html", 5),
        fileAtt("c", "c.bin", "", 5),
      ],
      { a: Buffer.from("<svg/>"), b: Buffer.from("<html>"), c: Buffer.from("zz") },
    );
    await run();
    expect(typesStored()).toEqual(["application/octet-stream", "application/octet-stream", "application/octet-stream"]);
  });

  it("downgrades an image whose bytes disagree and normalises a genuine type", async () => {
    routeAttachments(
      [fileAtt("a", "a.png", "image/png", 5), fileAtt("b", "b.pdf", "Application/PDF; x=1", 8)],
      { a: Buffer.from("<svg/>"), b: PDF },
    );
    await run();
    expect(typesStored()).toEqual(["application/octet-stream", "application/pdf"]);
  });
});

describe("graphFetchEmails → reply headers (EB3)", () => {
  it("reads In-Reply-To and References from the message headers, normalised", async () => {
    routeGraph([
      {
        from: { emailAddress: { address: "tenant@example.test", name: "T" } },
        hasAttachments: false,
        id: "g-reply",
        internetMessageHeaders: [
          { name: "In-Reply-To", value: "<Parent@Randazzo.Properties>" },
          { name: "References", value: "<root@randazzo.properties>\r\n <Parent@Randazzo.Properties>" },
        ],
        internetMessageId: "<reply@x>",
      },
      { from: { emailAddress: { address: "tenant@example.test", name: "T" } }, hasAttachments: false, id: "g-new", internetMessageId: "<new@x>" },
    ]);

    const emails = await graphFetchEmails("inbox@example.test");

    expect(emails.map((e) => [e.internetMessageId, e.inReplyTo, e.referenceIds])).toEqual([
      ["<reply@x>", "parent@randazzo.properties", "root@randazzo.properties parent@randazzo.properties"],
      ["<new@x>", null, null],
    ]);
  });
});
