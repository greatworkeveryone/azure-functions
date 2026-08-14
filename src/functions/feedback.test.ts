/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "test@co.com",
      name: "Test User",
      oid: "caller-oid-123",
    }),
  };
});

jest.mock("../graph", () => ({ graphSendMail: jest.fn().mockResolvedValue(undefined) }));

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));

jest.mock("../sentry", () => ({
  Sentry: {
    captureMessage: jest.fn(),
    captureException: jest.fn(),
  },
}));

const auth = require("../auth") as {
  errorResponse: jest.Mock;
  requireRole: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const graph = require("../graph") as { graphSendMail: jest.Mock };
const rateLimit = require("../rateLimit") as { checkRateLimit: jest.Mock };
const sentry = require("../sentry") as {
  Sentry: { captureMessage: jest.Mock; captureException: jest.Mock };
};

import { AppRole } from "../auth";
import { handleSendFeedback } from "./feedback";

const context = new InvocationContext();

function photo(name: string, type = "image/jpeg", bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Minimal HttpRequest stand-in — the handler only calls formData(). */
function requestWith(form: FormData): HttpRequest {
  const request = { formData: async () => form };
  return Object.assign(Object.create(HttpRequest.prototype), request);
}

/** A request whose multipart body fails to parse. */
function requestWithUnparseableBody(): HttpRequest {
  const request = {
    formData: async () => {
      throw new Error("Malformed multipart body");
    },
  };
  return Object.assign(Object.create(HttpRequest.prototype), request);
}

/** Parses fine, then throws once the handler walks the entries — stands in for
 *  an unexpected fault after the parse, which must stay a 500. */
function requestThatThrowsAfterParse(): HttpRequest {
  const form = validForm();
  const exploding = Object.create(FormData.prototype) as FormData;
  exploding.get = form.get.bind(form);
  exploding.entries = () => {
    throw new Error("unexpected fault");
  };
  return requestWith(exploding);
}

function validForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("body", "The rent review date is a year out.");
  form.append("customTopic", "");
  form.append("topic", "data");
  form.append("url", "https://app.example.com/tenancy");
  form.append("userAgent", "Mozilla/5.0");
  form.append("viewport", "390 × 844");
  Object.entries(overrides).forEach(([key, value]) => form.set(key, value));
  return form;
}

describe("handleSendFeedback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auth.requireRole.mockResolvedValue(null);
    auth.verifiedIdentityFromRequest.mockResolvedValue({
      email: "test@co.com",
      name: "Test User",
      oid: "caller-oid-123",
    });
    graph.graphSendMail.mockResolvedValue(undefined);
    rateLimit.checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
    process.env.FEEDBACK_EMAIL_RECIPIENTS = "connor@example.com";
  });

  it("sends the email and returns 200", async () => {
    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(200);
    expect(graph.graphSendMail).toHaveBeenCalledTimes(1);
    const [recipients, subject, body] = graph.graphSendMail.mock.calls[0];
    expect(recipients).toEqual(["connor@example.com"]);
    expect(subject).toContain("Data looks wrong");
    expect(body).toContain("The rent review date is a year out.");
  });

  it("forwards the diagnostic context fields to the email builder", async () => {
    await handleSendFeedback(requestWith(validForm()), context);

    const [, , body] = graph.graphSendMail.mock.calls[0];
    expect(body).toContain("Page:     https://app.example.com/tenancy");
    expect(body).toContain("Browser:  Mozilla/5.0");
    expect(body).toContain("Viewport: 390 × 844");
  });

  it("uses the verified identity, never a body-supplied name", async () => {
    const form = validForm();
    form.append("name", "Someone Else");
    form.append("email", "spoofed@evil.com");

    await handleSendFeedback(requestWith(form), context);

    const [, subject, body] = graph.graphSendMail.mock.calls[0];
    expect(subject).toContain("Test User");
    expect(body).toContain("test@co.com");
    expect(body).not.toContain("spoofed@evil.com");
    expect(body).not.toContain("Someone Else");
  });

  it("gates on the baseline USER role", async () => {
    await handleSendFeedback(requestWith(validForm()), context);

    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), [AppRole.USER]);
  });

  it("rejects a caller without a role", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });

    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(403);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("rejects a caller whose token cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);

    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(401);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("rejects an unknown topic", async () => {
    const response = await handleSendFeedback(
      requestWith(validForm({ topic: "urgent" })),
      context,
    );

    expect(response.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const response = await handleSendFeedback(requestWith(validForm({ body: "   " })), context);

    expect(response.status).toBe(400);
  });

  it("rejects topic 'other' with no custom topic", async () => {
    const response = await handleSendFeedback(
      requestWith(validForm({ customTopic: "", topic: "other" })),
      context,
    );

    expect(response.status).toBe(400);
  });

  it("rejects a custom topic over the character cap", async () => {
    const response = await handleSendFeedback(
      requestWith(validForm({ customTopic: "x".repeat(81), topic: "other" })),
      context,
    );

    expect(response.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("counts a custom topic in code points, not UTF-16 units", async () => {
    // 41 emoji is 41 characters to the user but 82 UTF-16 units — rejecting it
    // as "over 80 characters" would be untrue for the person who typed it.
    const response = await handleSendFeedback(
      requestWith(validForm({ customTopic: "😀".repeat(41), topic: "other" })),
      context,
    );

    expect(response.status).toBe(200);
  });

  it("rejects a body over the character cap", async () => {
    const response = await handleSendFeedback(
      requestWith(validForm({ body: "x".repeat(4001) })),
      context,
    );

    expect(response.status).toBe(400);
  });

  it("attaches up to three photos as base64", async () => {
    const form = validForm();
    form.append("photo0", photo("one.jpg"));
    form.append("photo1", photo("two.jpg"));
    form.append("photo2", photo("three.jpg"));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(200);
    const attachments = graph.graphSendMail.mock.calls[0][3];
    expect(attachments).toHaveLength(3);
    expect(attachments[0]).toEqual({
      contentBase64: expect.any(String),
      contentType: "image/jpeg",
      fileName: "photo-1.jpg",
    });
  });

  it("generates attachment filenames instead of trusting the client's", async () => {
    const form = validForm();
    // RTLO renders this as "eviluser.png" in a mail client while it is an .exe.
    form.append("photo0", photo("eviluser‮gnp.exe"));
    form.append("photo1", photo("shot.png", "image/png"));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(200);
    const attachments = graph.graphSendMail.mock.calls[0][3];
    expect(attachments[0].fileName).toBe("photo-1.jpg");
    expect(attachments[1].fileName).toBe("photo-2.png");
  });

  it("rejects photos that are individually legal but too large in total", async () => {
    const form = validForm();
    const oneAndAHalfMib = 1.5 * 1024 * 1024;
    form.append("photo0", photo("a.jpg", "image/jpeg", oneAndAHalfMib));
    form.append("photo1", photo("b.jpg", "image/jpeg", oneAndAHalfMib));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("ignores a string-valued photo field rather than crashing", async () => {
    const form = validForm();
    form.append("photo0", "not-a-file");

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(200);
    expect(graph.graphSendMail.mock.calls[0][3]).toHaveLength(0);
  });

  it("rejects a fourth photo", async () => {
    const form = validForm();
    form.append("photo0", photo("one.jpg"));
    form.append("photo1", photo("two.jpg"));
    form.append("photo2", photo("three.jpg"));
    form.append("photo3", photo("four.jpg"));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("rejects a fourth photo sent under a non-contiguous index", async () => {
    const form = validForm();
    form.append("photo0", photo("one.jpg"));
    form.append("photo1", photo("two.jpg"));
    form.append("photo2", photo("three.jpg"));
    form.append("photo4", photo("four.jpg"));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("collects a photo sent under a non-contiguous index rather than dropping it", async () => {
    const form = validForm();
    form.append("photo4", photo("lonely.jpg"));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(200);
    const attachments = graph.graphSendMail.mock.calls[0][3];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].fileName).toBe("photo-1.jpg");
  });

  it("rejects an oversized photo", async () => {
    const form = validForm();
    form.append("photo0", photo("huge.jpg", "image/jpeg", 2 * 1024 * 1024 + 1));

    const response = await handleSendFeedback(requestWith(form), context);

    expect(response.status).toBe(400);
  });

  it("rejects a non-image attachment, including svg", async () => {
    const pdfForm = validForm();
    pdfForm.append("photo0", photo("doc.pdf", "application/pdf"));
    expect((await handleSendFeedback(requestWith(pdfForm), context)).status).toBe(400);

    const svgForm = validForm();
    svgForm.append("photo0", photo("x.svg", "image/svg+xml"));
    expect((await handleSendFeedback(requestWith(svgForm), context)).status).toBe(400);
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30_000 });

    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(429);
    expect(new Headers(response.headers).get("Retry-After")).toBe("30");
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("rate limits on the verified oid, not on anything client-supplied", async () => {
    await handleSendFeedback(requestWith(validForm()), context);

    expect(rateLimit.checkRateLimit).toHaveBeenCalledWith("sendFeedback:caller-oid-123", {
      limit: 5,
      windowMs: 60_000,
    });
  });

  it("returns 400 without paging Sentry when the multipart body is unparseable", async () => {
    const response = await handleSendFeedback(requestWithUnparseableBody(), context);

    expect(response.status).toBe(400);
    expect(sentry.Sentry.captureException).not.toHaveBeenCalled();
    expect(auth.errorResponse).not.toHaveBeenCalled();
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("still returns 500 for an unexpected fault after the body parses", async () => {
    const response = await handleSendFeedback(requestThatThrowsAfterParse(), context);

    expect(response.status).toBe(500);
    expect(auth.errorResponse).toHaveBeenCalled();
  });

  it("returns 500 when no recipients are configured", async () => {
    process.env.FEEDBACK_EMAIL_RECIPIENTS = "";

    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(500);
    expect(auth.errorResponse).toHaveBeenCalledWith(
      expect.stringContaining("FEEDBACK_EMAIL_RECIPIENTS"),
    );
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("returns 502 and reports to Sentry when Graph fails", async () => {
    const failure = new Error("Graph sendMail failed: 503");
    graph.graphSendMail.mockRejectedValue(failure);

    const response = await handleSendFeedback(requestWith(validForm()), context);

    expect(response.status).toBe(502);
    expect(sentry.Sentry.captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ extra: expect.anything() }),
    );
  });
});
