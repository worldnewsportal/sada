// Test bootstrap: point the shared Prisma singleton at the test database
// BEFORE any src module gets imported (see bunfig.toml [test] preload).
process.env.DATABASE_URL = "file:./db/test.db";
process.env.OTP_DEV_ECHO = "false";
