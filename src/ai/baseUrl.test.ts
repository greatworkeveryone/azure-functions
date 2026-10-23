/// <reference types="jest" />
import { checkBaseUrl } from "./baseUrl";

// AI_BASE_URL: https to anywhere, or plain http only to this machine or a private (RFC 1918) address
// on RP's own network (review L4). A prompt, redacted or not, never crosses the internet unencrypted.

const problemOf = (raw: string | null): string => {
  const checked = checkBaseUrl(raw);
  if (checked.ok) throw new Error(`expected ${String(raw)} to be refused`);
  return checked.problem;
};

describe("https is accepted for any host", () => {
  it.each([
    "https://llm.example",
    "https://llm.example/",
    "https://llm.example:8443/prefix",
    "https://LLM.Example",
    "HTTPS://llm.example",
    "https://10.4.0.7",
    "https://8.8.8.8:8000",
    "https://[2001:db8::1]:8000",
  ])("accepts %s", (raw) => {
    expect(checkBaseUrl(raw)).toEqual({ ok: true });
  });
});

describe("plain http is accepted only for this machine and private addresses", () => {
  it.each([
    "http://localhost:11434",
    "http://LOCALHOST:11434",
    "http://127.0.0.1:8000",
    "http://127.1.2.3",
    "http://[::1]:8000",
    "http://10.4.0.7:8000",
    "http://10.0.0.0",
    "http://10.255.255.255",
    "http://172.16.0.1",
    "http://172.31.255.254:8000",
    "http://192.168.0.1",
    "http://192.168.1.20:8000/prefix",
  ])("accepts %s", (raw) => {
    expect(checkBaseUrl(raw)).toEqual({ ok: true });
  });

  it("reads an address the way fetch will, so a number written another way is judged by what it is", () => {
    expect(checkBaseUrl("http://2130706433")).toEqual({ ok: true });
    expect(checkBaseUrl("http://0x7f.0.0.1")).toEqual({ ok: true });
    expect(checkBaseUrl("http://3232235777")).toEqual({ ok: true });
    expect(problemOf("http://134744072")).toMatch(/https/);
    expect(problemOf("http://010.0.0.1")).toMatch(/https/);
  });

  it.each([
    "http://llm.example",
    "http://vllm.internal:8000",
    "http://example.com:8000",
    "http://8.8.8.8",
    "http://11.0.0.1",
    "http://172.15.255.255",
    "http://172.32.0.1",
    "http://192.167.1.1",
    "http://192.169.1.1",
    "http://100.64.0.1",
    "http://0.0.0.0",
    "http://[fd00::1]",
    "http://[::ffff:10.0.0.1]",
    "http://[2001:db8::1]",
  ])("refuses %s, and says to use https or a private address", (raw) => {
    const problem = problemOf(raw);
    expect(problem).toMatch(/AI_BASE_URL must use https/);
    expect(problem).toMatch(/localhost|private/);
  });

  it.each([
    "http://10.0.0.1.evil.example",
    "http://127.0.0.1.nip.io",
    "http://localhost.evil.example",
    "http://localhost.",
    "http://192.168.1.1.example:8000",
  ])("refuses %s: a name that starts like a private address is still a name", (raw) => {
    expect(problemOf(raw)).toMatch(/AI_BASE_URL must use https/);
  });

  it("refuses the cloud metadata address over http and https, in its own words", () => {
    for (const raw of ["http://169.254.169.254", "https://169.254.169.254", "http://169.254.1.1:8000", "https://169.254.0.5"]) {
      expect(problemOf(raw)).toMatch(/link-local/);
    }
  });
});

describe("what is not a usable address", () => {
  it.each([
    [null, /not set/],
    ["", /not set/],
    ["llm.example", /not a URL/],
    ["//llm.example", /not a URL/],
    ["llm dot example", /not a URL/],
    ["ftp://llm.example", /https/],
    ["file:///etc/passwd", /https/],
    ["javascript:alert(1)", /https/],
    ["ws://llm.example", /https/],
  ])("refuses %j", (raw, problem) => {
    expect(problemOf(raw)).toMatch(problem);
  });

  it.each(["https://user:pw@llm.example", "https://user@llm.example", "http://10.0.0.1@evil.example", "http://:pw@10.0.0.1"])(
    "refuses %s: a key belongs in AI_API_KEY, not in the address",
    (raw) => {
      expect(problemOf(raw)).toMatch(/user name or password/);
    },
  );

  it.each(["https://llm.example?key=abc", "https://llm.example/v1?x=1", "https://llm.example#frag", "https://llm.example/#x", "https://llm.example?", "http://10.0.0.1/#@evil.example"])(
    "refuses %s: nothing after the address is sent on",
    (raw) => {
      expect(problemOf(raw)).toMatch(/query string or fragment/);
    },
  );

  it("never repeats the address in what it says, so a secret in it cannot reach a log", () => {
    for (const raw of ["https://user:s3cret@llm.example", "http://secret-host.example", "https://llm.example?token=s3cret", "s3cret"]) {
      expect(problemOf(raw)).not.toMatch(/s3cret|secret-host/);
    }
  });
});
