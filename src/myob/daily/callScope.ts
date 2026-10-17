// Which company file a logged MYOB call was about (plan M4 review), by the same
// classifier myobRequest guards with, under the configured API base. The log
// keeps only the path, so the call is rebuilt on the base's origin first.
//   account  the sign-in exchange or the company-file list: no file
//   file     the classifier's file, or for a refused call the first segment
//            below the base when it is a company-file id
//   unknown  anything else (another base, an unreadable path): never listed,
//            since it could name a file the CFO has not registered

import { classifyMyobRequest, MYOB_TOKEN_URL } from "../../myob-endpoints";

export type CallScope = { kind: "account" } | { file: string; kind: "file" } | { kind: "unknown" };

const FIRST_SEGMENT_FILE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/i;
const TOKEN_PATH = new URL(MYOB_TOKEN_URL).pathname.replace(/\/+$/, "");

export function callScope(method: string, path: string, apiBase: string): CallScope {
  if (path.split("?")[0].replace(/\/+$/, "") === TOKEN_PATH) return { kind: "account" };
  let base: URL;
  let url: URL;
  try {
    base = new URL(apiBase);
    url = new URL(path, base.origin);
  } catch {
    return { kind: "unknown" };
  }
  if (!path.startsWith("/")) return { kind: "unknown" };
  const classified = classifyMyobRequest(method, url.href, apiBase);
  if (classified.kind === "endpoint") return classified.companyFileId ? { file: classified.companyFileId, kind: "file" } : { kind: "account" };
  const basePath = base.pathname.replace(/\/+$/, "");
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return { kind: "unknown" };
  const below = url.pathname.slice(basePath.length) || "/";
  if (below === "/") return { kind: "account" };
  const file = FIRST_SEGMENT_FILE.exec(below)?.[1];
  return file ? { file: file.toLowerCase(), kind: "file" } : { kind: "unknown" };
}
