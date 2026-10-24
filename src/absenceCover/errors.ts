/** What a cover request can say no to, in words the screen shows as they are. */
export class CoverError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CoverError";
    this.code = code;
    this.status = status;
  }
}

export const coverError = {
  badRequest: (message: string) => new CoverError("bad_request", message, 400),
  changed: (message = "This changed while you were looking at it. Reload to see where it stands.") => new CoverError("changed", message, 409),
  forbidden: (message: string) => new CoverError("forbidden", message, 403),
  notFound: (message: string) => new CoverError("not_found", message, 404),
  refused: (code: string, message: string) => new CoverError(code, message, 422),
  switchedOff: () =>
    new CoverError("cover_switched_off", "Automatic cover is switched off, so items are not moved from here. Ask Will to switch it on.", 409),
};
