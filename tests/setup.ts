// Test bootstrap: point the shared Prisma singleton at the test database
// BEFORE any src module gets imported (see bunfig.toml [test] preload).
process.env.DATABASE_URL = "file:./db/test.db";
// Dev-echo ON so integration tests can read the OTP code from the response
// (mirrors dev behavior; production never loads this file and the echo is
// force-disabled there by NODE_ENV checks in env.ts).
process.env.OTP_DEV_ECHO = "true";
