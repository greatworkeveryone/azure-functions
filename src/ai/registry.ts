// The purpose allowlist (SC-AI1). Every file in ./purposes exports one `purpose`;
// this module finds them, checks each is well formed, and hands them out by id.
// Adding a purpose is therefore one new file, with no edit here, which also keeps
// parallel branches that each add one from touching the same lines.
//
// Loaded on first use, not at import, so a broken purpose file fails the call that
// needs it (and the registry test) instead of every module that imports the gateway.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AiPurpose } from "./types";

const PURPOSES_DIR = join(__dirname, "purposes");
// `echoTest.ts` in source, `echoTest.js` once compiled: not `.d.ts`, `.test.ts` or `.map`.
const PURPOSE_FILE = /^([A-Za-z][A-Za-z0-9]*)\.(?:ts|js)$/;
const ID = /^[a-z][a-z0-9_]{0,63}$/;

function check(candidate: unknown, file: string): AiPurpose {
  const problem = (why: string) => new Error(`AI purpose in ${file}: ${why}`);
  const purpose = candidate as Partial<AiPurpose> | undefined;
  if (!purpose || typeof purpose !== "object") throw problem("it does not export `purpose`");
  if (typeof purpose.id !== "string" || !ID.test(purpose.id)) throw problem("`id` must be snake_case, up to 64 characters");
  if (typeof purpose.promptVersion !== "string" || !new RegExp(`^${purpose.id}@[1-9]\\d*$`).test(purpose.promptVersion)) {
    throw problem(`\`promptVersion\` must be "${purpose.id}@" and a whole number`);
  }
  const wholeBetween = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;
  if (!wholeBetween(purpose.maxInputChars, 200_000)) throw problem("`maxInputChars` must be a whole number up to 200,000");
  if (!wholeBetween(purpose.maxOutputTokens, 8_192)) throw problem("`maxOutputTokens` must be a whole number up to 8,192");
  if (typeof purpose.systemPrompt !== "string" || purpose.systemPrompt.trim() === "") throw problem("`systemPrompt` is empty");
  if (typeof purpose.expectsJson !== "boolean") throw problem("`expectsJson` must be true or false");
  if (typeof purpose.validate !== "function" || typeof purpose.mock !== "function") throw problem("`validate` and `mock` must be functions");
  return purpose as AiPurpose;
}

let registry: ReadonlyMap<string, AiPurpose> | null = null;

function load(): ReadonlyMap<string, AiPurpose> {
  const found = new Map<string, AiPurpose>();
  const modules = new Set(
    readdirSync(PURPOSES_DIR).flatMap((name) => {
      const match = name.match(PURPOSE_FILE);
      return match ? [match[1]] : [];
    }),
  );
  for (const module of [...modules].sort()) {
    // The folder is this package's own code, listed just above; sync so the first call needs no await.
    const purpose = check((require(join(PURPOSES_DIR, module)) as { purpose?: unknown }).purpose, module);
    if (found.has(purpose.id)) throw new Error(`AI purpose ${purpose.id} is defined twice (${module})`);
    found.set(purpose.id, purpose);
  }
  return found;
}

/** The purpose with this id, or undefined: the caller refuses with purpose_not_allowed. */
export function getPurpose(id: unknown): AiPurpose | undefined {
  registry ??= load();
  return typeof id === "string" ? registry.get(id) : undefined;
}

export function listPurposeIds(): string[] {
  registry ??= load();
  return [...registry.keys()].sort();
}
