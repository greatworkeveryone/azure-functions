import { app } from "@azure/functions";
import { runMigrations } from "../migrate";

// Runs once when the function app initialises, before any requests are served.
// If migrations fail the app refuses to start — better than serving requests
// against a schema that's out of date.
app.hook.appStart(async (_context) => {
  // AZURE_FUNCTIONS_ENVIRONMENT is "Production" in Azure, "Development" locally.
  // Skip migrations locally — the local DB user doesn't have DDL permissions.
  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT !== "Production") {
    console.log("startup: skipping migrations (not running in Azure)");
    return;
  }
  console.log("startup: running migrations");
  await runMigrations((msg) => console.log(msg));
  console.log("startup: migrations complete");
});
