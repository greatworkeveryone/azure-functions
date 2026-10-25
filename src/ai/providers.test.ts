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
  readAiConfig({ AI_BASE_URL: "http://10.4.0.7:8000", AI_MODEL: "llama-3.1-8b", AI_PROVIDER: "openai_compatible", ...env });
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
    ["http://10.4.0.7:8000", "http://10.4.0.7:8000/v1/chat/completions"],
    ["http://localhost:11434/", "http://localhost:11434/v1/chat/completions"],
    ["https://llm.example/", "https://llm.example/v1/chat/completions"],
    ["https://llm.example///", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/prefix", "https://llm.example/prefix/v1/chat/completions"],
  ])("builds %s into %s", (base, expected) => {
    expect(chatCompletionsUrl(base)).toBe(expected);
  });

  it.each([null, "", "llm.example", "ftp://llm.example", "file:///etc/passwd", "javascript:alert(1)"])("refuses %j", (base) => {
    expect(() => chatCompletionsUrl(base)).toThrow(AiProviderFailure);
  });

  it.each([
    "http://llm.example",
    "http://vllm.internal:8000",
    "http://8.8.8.8:8000",
    "http://169.254.169.254",
    "https://169.254.169.254",
    "https://user:pw@llm.example",
    "https://llm.example?key=abc",
  ])("refuses %s as provider_error, with a sentence that says what to change", (base) => {
    expect.assertions(3);
    try {
      chatCompletionsUrl(base);
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderFailure);
      expect((error as AiProviderFailure).code).toBe("provider_error");
      expect((error as AiProviderFailure).message).toMatch(/^AI_BASE_URL (must|points at)/);
    }
  });

  it("says plainly that plain http is for localhost and private addresses only", () => {
    expect(() => chatCompletionsUrl("http://llm.example")).toThrow(/must use https\. Plain http is allowed only to localhost or a private address/);
  });
});

describe("the request to an openai-compatible endpoint", () => {
  it("posts the model, temperature 0, the token cap and the system and user messages", async () => {
    fetchMock.mockResolvedValue(reply('{"echo":"x"}'));
    await callOpenAiCompatible(config(), echoTest, "hello");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://10.4.0.7:8000/v1/chat/completions");
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
    fetchMock.mockImplementation(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
            },
          }),
        ),
    );
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
    fetchMock.mockRejectedValue(new TypeError("getaddrinfo ENOTFOUND llm.internal"));
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

  it("accepts an answer just under the size limit", async () => {
    fetchMock.mockResolvedValue(reply("x".repeat(990_000)));
    expect((await callOpenAiCompatible(config(), echoTest, "hello")).text).toHaveLength(990_000);
  });

  it.each(["http://llm.example", "http://vllm.internal:8000", "https://user:pw@llm.example"])("does not call out at all to %s", async (base) => {
    const failure = await failureOf(() => callOpenAiCompatible(config({ AI_BASE_URL: base }), echoTest, "hello"));
    expect(failure.message).toMatch(/^AI_BASE_URL must/);
    expect(failure.message).not.toContain("pw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call out at all without a model", async () => {
    await failureOf(() => callOpenAiCompatible(config({ AI_MODEL: "" }), echoTest, "hello"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// The body is read as it arrives and abandoned at 1 MB, so an endpoint that never stops cannot fill memory (review L4).
describe("how much of an answer is read", () => {
  const CHUNK = 100_000;
  const endless = (chunks: number, headers: Record<string, string> = {}) => {
    const seen = { cancelled: false, pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        seen.cancelled = true;
      },
      pull(controller) {
        seen.pulled += 1;
        if (seen.pulled > chunks) controller.close();
        else controller.enqueue(new Uint8Array(CHUNK).fill(120));
      },
    });
    return { response: new Response(body, { headers }), seen };
  };

  it("stops reading a body that goes on past the limit, and abandons it", async () => {
    const { response, seen } = endless(1_000);
    fetchMock.mockResolvedValue(response);
    const failure = await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"));
    expect(failure).toMatchObject({ code: "provider_error", message: "The AI endpoint's answer was far too long" });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(20);
  });

  it("does not read a body whose declared length is already over the limit", async () => {
    const { response, seen } = endless(1_000, { "content-length": "5000000" });
    fetchMock.mockResolvedValue(response);
    const failure = await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"));
    expect(failure.message).toBe("The AI endpoint's answer was far too long");
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThanOrEqual(2);
  });

  it("puts an answer back together from chunks, including a character split between two of them", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "caf\u00e9 au lait" } }] }));
    const cut = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    expect((await callOpenAiCompatible(config(), echoTest, "hello")).text).toBe("caf\u00e9 au lait");
  });

  it("counts bytes, not characters: a short text of wide characters is still bounded", async () => {
    fetchMock.mockResolvedValue(reply("\u20ac".repeat(400_000)));
    expect((await failureOf(() => callOpenAiCompatible(config(), echoTest, "hello"))).message).toBe("The AI endpoint's answer was far too long");
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
    for (const env of [{ AI_PROVIDER: "openai" }, { AI_BASE_URL: "" }, { AI_MODEL: "" }, { AI_BASE_URL: "http://llm.example" }]) {
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
