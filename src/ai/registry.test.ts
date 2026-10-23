/// <reference types="jest" />
import { join } from "node:path";
import { getPurpose, listPurposeIds } from "./registry";
import { interpretOutput } from "./output";

const PURPOSES_DIR = join(__dirname, "purposes");

describe("the purpose registry", () => {
  it("finds echo_test, the one purpose seeded here, and nothing else yet", () => {
    expect(listPurposeIds()).toEqual(expect.arrayContaining(["echo_test"]));
    expect(getPurpose("echo_test")).toMatchObject({ id: "echo_test", promptVersion: "echo_test@1" });
  });

  it.each([undefined, null, 1, {}, "", "ECHO_TEST", "echo_test ", "__proto__", "constructor", "hasOwnProperty"])("has no purpose for %j", (id) => {
    expect(getPurpose(id)).toBeUndefined();
  });
});

// The rules every purpose, now and in later packages, has to meet. A new purpose
// file that breaks one fails here, in its own package's run.
describe.each(listPurposeIds())("purpose %s", (id) => {
  const purpose = getPurpose(id)!;

  it("has a snake_case id, a versioned prompt and sane limits", () => {
    expect(purpose.id).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(purpose.promptVersion).toMatch(new RegExp(`^${id}@[1-9]\\d*$`));
    expect(purpose.maxInputChars).toBeGreaterThan(0);
    expect(purpose.maxInputChars).toBeLessThanOrEqual(200_000);
    expect(purpose.maxOutputTokens).toBeGreaterThan(0);
    expect(purpose.maxOutputTokens).toBeLessThanOrEqual(8_192);
    expect(purpose.systemPrompt.trim()).not.toBe("");
  });

  it("has a mock that is deterministic and passes its own validator", () => {
    for (const input of ["sample text", "Call Jo on [PHONE]", "x".repeat(Math.min(purpose.maxInputChars, 50))]) {
      const first = purpose.mock(input);
      expect(purpose.mock(input)).toBe(first);
      expect({ id, input, verdict: interpretOutput(purpose, first) }).toMatchObject({ verdict: { ok: true } });
    }
  });

  it("has a validator that refuses junk instead of throwing", () => {
    for (const junk of [undefined, null, 42, true, [], {}, ""]) {
      expect(() => purpose.validate(junk)).not.toThrow();
    }
    expect(purpose.validate(null)).toMatchObject({ ok: false });
    expect(purpose.validate([])).toMatchObject({ ok: false });
  });
});

describe("a broken purpose file fails loudly, and a folder's other files are ignored", () => {
  function registryWith(files: string[], modules: Record<string, unknown>) {
    let loaded!: typeof import("./registry");
    jest.isolateModules(() => {
      jest.doMock("node:fs", () => ({ readdirSync: () => files }));
      for (const [name, value] of Object.entries(modules)) jest.doMock(join(PURPOSES_DIR, name), () => value, { virtual: true });
      loaded = require("./registry");
    });
    return loaded;
  }
  const good = (id: string) => ({
    purpose: {
      expectsJson: true,
      id,
      maxInputChars: 10,
      maxOutputTokens: 10,
      mock: () => "{}",
      promptVersion: `${id}@1`,
      systemPrompt: "x",
      validate: () => ({ ok: true, value: {} }),
    },
  });

  afterEach(() => {
    jest.dontMock("node:fs");
    jest.resetModules();
  });

  it("loads source and compiled files, and skips tests, declarations and maps", () => {
    const registry = registryWith(["alpha.ts", "beta.js", "alpha.test.ts", "alpha.d.ts", "beta.js.map", "README.md", ".hidden.ts"], {
      alpha: good("alpha"),
      beta: good("beta"),
    });
    expect(registry.listPurposeIds()).toEqual(["alpha", "beta"]);
  });

  it("refuses two purposes with one id", () => {
    const registry = registryWith(["one.ts", "two.ts"], { one: good("same"), two: good("same") });
    expect(() => registry.listPurposeIds()).toThrow(/defined twice/);
  });

  it.each([
    ["no purpose export", {}],
    ["a bad id", { purpose: { ...good("Bad-Id").purpose } }],
    ["a prompt version for another purpose", { purpose: { ...good("one").purpose, promptVersion: "two@1" } }],
    ["a prompt version with no number", { purpose: { ...good("one").purpose, promptVersion: "one@" } }],
    ["a prompt version of 0", { purpose: { ...good("one").purpose, promptVersion: "one@0" } }],
    ["no input cap", { purpose: { ...good("one").purpose, maxInputChars: 0 } }],
    ["an enormous input cap", { purpose: { ...good("one").purpose, maxInputChars: 5_000_000 } }],
    ["a fractional output cap", { purpose: { ...good("one").purpose, maxOutputTokens: 1.5 } }],
    ["an empty prompt", { purpose: { ...good("one").purpose, systemPrompt: "  " } }],
    ["expectsJson that is not a boolean", { purpose: { ...good("one").purpose, expectsJson: "yes" } }],
    ["no validator", { purpose: { ...good("one").purpose, validate: undefined } }],
    ["no mock", { purpose: { ...good("one").purpose, mock: undefined } }],
  ])("refuses a file with %s", (_label, module) => {
    const registry = registryWith(["one.ts"], { one: module });
    expect(() => registry.getPurpose("one")).toThrow(/AI purpose in one/);
  });
});
