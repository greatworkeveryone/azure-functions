import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import * as fs from "fs";
import * as path from "path";

async function swaggerUI(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  return {
    status: 200,
    headers: { "Content-Type": "text/html" },
    body: `<!DOCTYPE html>
<html>
<head>
  <title>RPCC Functions API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
    });
  </script>
</body>
</html>`,
  };
}

async function openApiSpec(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const specPath = path.join(__dirname, "..", "openapi.json");
  const spec = fs.readFileSync(specPath, "utf-8");

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: spec,
  };
}

app.http("swagger", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "docs",
  handler: swaggerUI,
});

app.http("openapi", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "openapi.json",
  handler: openApiSpec,
});
