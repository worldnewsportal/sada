// Test bootstrap: point the shared Prisma singleton at the test database
// BEFORE any src module gets imported (see bunfig.toml [test] preload).
process.env.DATABASE_URL = "file:./db/test.db";
// Dev-echo ON so integration tests can read the OTP code from the response
// (mirrors dev behavior; production never loads this file and the echo is
// force-disabled there by NODE_ENV checks in env.ts).
process.env.OTP_DEV_ECHO = "true";

// Isolate provider config from the REAL project .env: it now contains real
// provider credentials (e.g. RESEND_API_KEY). Bun AUTO-LOADS the project
// .env into process.env and (observed empirically) RE-INJECTS it after
// preload — so deleting the vars here does NOT stick. Overwriting with ""
// DOES stick (Bun's loader skips already-set vars), and empty = unconfigured
// for the provider chain (envFileGet treats "" as falsy). The PROJECT_ROOT
// sandbox below also empties the .env-file fallback, so the provider matrix
// stays deterministic (tests drive config via process.env only).
for (const k of ["RESEND_API_KEY", "BREVO_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "EMAIL_CHAIN"]) {
  process.env[k] = "";
}
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const sandboxRoot = mkdtempSync(join(tmpdir(), "sada-test-root-"));
writeFileSync(join(sandboxRoot, ".env"), "# empty sandbox env for tests\n");
process.env.PROJECT_ROOT = sandboxRoot;
