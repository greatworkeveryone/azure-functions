import { classifyStatus, createGraphSender, MailSendError, toSendError } from "./graphSend";

type Call = { body: unknown; headers: Record<string, string>; method: string; url: string };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string>, method: String(init.method), url });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
const draft = { from: { address: "notices@randazzo.properties", name: "Randazzo Properties" }, html: "<p>Hi</p>", replyTo: { address: "accounts@randazzo.properties", name: "Accounts" }, subject: "Hello", to: "pat@example.com" };

describe("createDraft then sendDraft", () => {
  it("makes the draft as the shared mailbox, with the reply-to, and keeps both ids", async () => {
    const { calls, impl } = fakeFetch([json({ id: "AAMk=", internetMessageId: "<abc@randazzo.properties>" })]);
    const token = jest.fn(async () => "tok");
    const result = await createGraphSender(impl, token).createDraft(draft);
    expect(result).toEqual({ graphMessageId: "AAMk=", internetMessageId: "<abc@randazzo.properties>" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/users/notices%40randazzo.properties/messages");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].body).toMatchObject({
      body: { content: "<p>Hi</p>", contentType: "HTML" },
      from: { emailAddress: { address: "notices@randazzo.properties", name: "Randazzo Properties" } },
      isDeliveryReceiptRequested: false,
      isReadReceiptRequested: false,
      replyTo: [{ emailAddress: { address: "accounts@randazzo.properties", name: "Accounts" } }],
      subject: "Hello",
      toRecipients: [{ emailAddress: { address: "pat@example.com" } }],
    });
  });

  it("sends the draft by its id", async () => {
    const { calls, impl } = fakeFetch([new Response(null, { status: 202 })]);
    await createGraphSender(impl, async () => "tok").sendDraft("notices@randazzo.properties", "AAMk=/x");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/users/notices%40randazzo.properties/messages/AAMk%3D%2Fx/send");
    expect(calls[0].body).toBeUndefined();
  });

  it("takes one token for a whole run", async () => {
    const { impl } = fakeFetch([json({ id: "1" }), new Response(null, { status: 202 }), json({ id: "2" }), new Response(null, { status: 202 })]);
    const token = jest.fn(async () => "tok");
    const sender = createGraphSender(impl, token);
    await sender.createDraft(draft);
    await sender.sendDraft("n@x", "1");
    await sender.createDraft(draft);
    await sender.sendDraft("n@x", "2");
    expect(token).toHaveBeenCalledTimes(1);
  });

  it("takes a fresh token once after a 401, and no more", async () => {
    const { calls, impl } = fakeFetch([new Response("expired", { status: 401 }), json({ id: "1" })]);
    const token = jest.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    await createGraphSender(impl, token).createDraft(draft);
    expect(calls.map((call) => call.headers.Authorization)).toEqual(["Bearer old", "Bearer new"]);
    const { impl: twice } = fakeFetch([new Response("x", { status: 401 }), new Response("x", { status: 401 })]);
    await expect(createGraphSender(twice, async () => "t").createDraft(draft)).rejects.toMatchObject({ code: "graph_auth", retryable: false });
  });

  it("refuses a draft response with no id", async () => {
    const { impl } = fakeFetch([json({})]);
    await expect(createGraphSender(impl, async () => "t").createDraft(draft)).rejects.toMatchObject({ code: "graph_rejected" });
  });

  it("keeps a null internet message id when Graph gives none", async () => {
    const { impl } = fakeFetch([json({ id: "1" })]);
    expect(await createGraphSender(impl, async () => "t").createDraft(draft)).toEqual({ graphMessageId: "1", internetMessageId: null });
  });

  it("never carries Graph's own text in an error", async () => {
    const { impl } = fakeFetch([new Response('{"error":{"message":"Recipient pat@example.com rejected"}}', { status: 400 })]);
    const error = await createGraphSender(impl, async () => "t").createDraft(draft).catch((e: unknown) => e as MailSendError);
    expect(error).toBeInstanceOf(MailSendError);
    expect(JSON.stringify([(error as Error).message, (error as MailSendError).code])).not.toContain("pat@example.com");
  });
});

describe("the error codes", () => {
  it.each([
    [429, "draft", "graph_throttled", true],
    [503, "draft", "graph_unavailable", true],
    [408, "send", "graph_unavailable", true],
    [401, "draft", "graph_auth", false],
    [403, "send", "graph_auth", false],
    [404, "draft", "graph_not_found", false],
    [404, "send", "send_unconfirmed", false],
    [400, "draft", "graph_rejected", false],
    [422, "send", "graph_rejected", false],
  ] as const)("status %s on %s is %s (retry: %s)", (status, step, code, retryable) => {
    expect(classifyStatus(status, step)).toMatchObject({ code, retryable });
  });

  it("maps a thrown error to a code without its text", () => {
    expect(toSendError(new Error("Graph credentials not configured (GRAPH_TENANT_ID)"))).toMatchObject({ code: "graph_not_configured", retryable: false });
    expect(toSendError(new Error("Graph token request failed: 401 — secret"))).toMatchObject({ code: "graph_auth", retryable: false });
    expect(toSendError(new Error("connect ECONNRESET"))).toMatchObject({ code: "network", retryable: true });
    expect(toSendError("weird")).toMatchObject({ code: "network" });
    expect(toSendError(new Error("Graph token request failed: 401 — secret")).message).not.toContain("secret");
  });

  it("turns a network failure into a retryable code", async () => {
    const { impl } = fakeFetch([new Error("socket hang up")]);
    await expect(createGraphSender(impl, async () => "t").createDraft(draft)).rejects.toMatchObject({ code: "network", retryable: true });
  });
});
