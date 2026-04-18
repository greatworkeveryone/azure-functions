import { HttpRequest, HttpResponseInit } from "@azure/functions";

export function extractToken(request: HttpRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.replace("Bearer ", "").trim() || null;
}

export function unauthorizedResponse(): HttpResponseInit {
  return {
    status: 401,
    jsonBody: { error: "No authorization token provided" },
  };
}

export function errorResponse(message: string, details: string): HttpResponseInit {
  return {
    status: 500,
    jsonBody: { error: message, details },
  };
}
