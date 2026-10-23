/// <reference types="jest" />
import { readAiConfig } from "./config";
import { callProvider } from "./providers";
import { callMock } from "./providers/mock";
import { callOpenAiCompatible, chatCompletionsUrl } from "./providers/openaiCompatible";
import { AiProviderFailure } from "./refusals";
import { definePurpose } from "./types";
import { purpose as echoTest } from "./purposes/echoTest";

const fetchMock = jest.fn();
const config = (env: Record<string, string | undefined> = {}) =>
  readAiConfig({ AI_BASE_URL: "http://vllm.internal:8000", AI_MODEL: "llama-3.1-8b", AI_PROVIDER: "openai_compatible", ...env });
const reply = (content: unknown, init: ResponseInit = {}) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), init);

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const failureOf = async (run: () => Promise<unknown>) => {
  const error = await run().then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AiProviderFailure);
  return error as AiProviderFailure;
};

describe("chatCompletionsUrl", () => {
  it.each([
    ["http://vllm.internal:8000", "http://vllm.internal:8000/v1/chat/completions"],
    ["https://llm.example/", "https://llm.example/v1/chat/completions"],
    ["https://llm.example///", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/prefix", "https://llm.example/prefix/v1/chat/completions"],
  ])("builds %s into %s", (base, expected) => {
    expect(chatCompletionsUrl(base)).toBe(expected);
  });

  it.each([null, "", "llm.example", "ftp://llm.example", "file:///etc/passwd", "javascript:alert(1)"])("refuses %j", (base) => {
    expect(() => chatCompletionsUrl(base)).toThrow(AiProviderFailure);
  });
});

describe("the request to an openai-compatible endpoint", () => {
  it("posts the model, temperature 0, the token cap and the system and user messages", async () => {
    fetchMock.mockResolvedValue(reply('{"echo":"x"}'));
    await callOpenAiCompatible(config(), echoTest, "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://vllm.internal:8000/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      max_tokens: 100,
      messages: [
        { content: echoTest.systemPrompt, role: "system" },
        { content: "hello", role: "user" },
      ],
      model: "llama-3.1-8b",
      response_format: { type: "json_object" },
      temperature: 0,
    });
  });

  it("leaves the JSON response format out for a purpose that answers in text", async () => {
    fetchMock.mockResolvedValue(reply("hi"));
    await callOpenAiCompatible(config(), { ...echoTest, expectsJson: false }, "hello");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("response_format");
  });

  it("sends a bearer token only when AI_API_KEY is set", async () => {
    fetchMock.mockImplementation(async () => reply('{"echo":"x"}'));
    await callOpenAiCompatible(config(), echoTest, "hello");
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("authorization");

    await callOpenAiCompatible(config({ AI_API_KEY: "s3cret" }), echoTest, "hello");
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ authorization: "Bearer s3cret" });
  });

  it("refuses redirects, so the key can never be handed to another host", async () => {
    fetchMock.mockResolvedValue(reply('{"echo":"x"}'));
    await callOpenAiCompatible(config({ AI_API_KEY: "k" }), echoTest, "hello");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it("returns the message text and the configured model", async () => {
    fetchMock.mockResolvedValue(reply('{"echo":"x"}'));
    expect(await callOpenAiCompatible(config(), echoTest, "hello")).toEqual({ model: "llama-3.1-8b", text: '{"echo":"x"}' });
  });
});

describe("how an openai-compatible call fails", () => {
  it("times out as a timeout, and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const failure = await failureOf(() => callOpenAiCompatible(config({ AI_TIMEOUT_MS: "25" }), echoTest, "hello"));
    expect(failure.code).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("counts the time spent reading the body against the timeout", async () => {
    // Headers arrive at once; the body never does, until the same signal aborts the read (as a real fetch does).
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }));
    const failure = await failureOf(() => callOpenAiCompatible(config({ AI_TIMEOUT_MS: "20" }), echoTest, "hello"));
    expect(failure.code).toBe("timeout");
  });

  it.each([400, 401, 429, 500, 503])("fails as provider_error on status %i, naming only the status", async (status) => {
    fetchMock.mockResolvedValue(new Response("the prompt was: hello, and the key is s3cret", { status }));
    const failure = await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"));
    expect(failure.code).toBe("provider_error");
    expect(failure.message).toBe(`The AI endpoint answered ${status}`);
    expect(failure.message).not.toContain("hello");
  });

  it("fails as provider_error when the endpoint cannot be reached, without its message", async () => {
    fetchMock.mockRejectedValue(new TypeError("getaddrinfo ENOTFOUND vllm.internal"));
    const failure = await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"));
    expect(failure).toMatchObject({ code: "provider_error", message: "The AI endpoint could not be reached" });
  });

  it.each([
    ["not JSON", new Response("<html>bad gateway</html>")],
    ["JSON with no choices", new Response("{}")],
    ["an empty choices list", new Response('{"choices":[]}')],
    ["a choice with no message", new Response('{"choices":[{}]}')],
    ["a message with no text", reply(null)],
    ["a message whose content is not text", reply(["a"])],
    ["a body that is a JSON string", new Response('"hello"')],
  ])("fails as provider_error for %s", async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    expect((await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"))).code).toBe("provider_error");
  });

  it("fails as provider_error for an answer of absurd length", async () => {
    fetchMock.mockResolvedValue(reply("x".repeat(1_100_000)));
    expect((await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"))).code).toBe("provider_error");
  });

  it("does not call out at all without a model", async () => {
    await failureOf(() => callOpenAiCompatible(config({ AI_MODEL: "" }), echoTest, "hello"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("callProvider", () => {
  it("uses the mock by default, and never the network", async () => {
    expect(await callProvider(readAiConfig({}), echoTest, "hello")).toEqual({ model: "mock", text: '{"echo":"hello"}' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the endpoint for openai_compatible", async () => {
    fetchMock.mockResolvedValue(reply('{"echo":"x"}'));
    await callProvider(config(), echoTest, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a name it does not know, and an endpoint with no URL or model, before sending", async () => {
    for (const env of [{ AI_PROVIDER: "openai" }, { AI_BASE_URL: "" }, { AI_MODEL: "" }]) {
      await failureOf(() => callProvider(config(env), echoTest, "hello"));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the mock provider", () => {
  it("is deterministic", () => {
    expect(callMock(echoTest, "same")).toEqual(callMock(echoTest, "same"));
  });

  it("fails as provider_error when a responder throws or returns no text", () => {
    const broken = (mock: () => unknown) => definePurpose({ ...echoTest, mock: mock as never });
    expect(() => callMock(broken(() => { throw new Error("secret"); }), "x")).toThrow(AiProviderFailure);
    expect(() => callMock(broken(() => undefined), "x")).toThrow(AiProviderFailure);
    try {
      callMock(broken(() => { throw new Error("secret"); }), "x");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
