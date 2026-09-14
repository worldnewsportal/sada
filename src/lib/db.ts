import { PrismaClient } from "@prisma/client";
import { log } from "@/lib/server/logger";

// Prisma client singleton with SQLite WAL + busy timeout for the multi-process
// topology (API + realtime + worker share the file in dev; production runs
// Postgres via docker-compose — see infrastructure/docker-compose.yml).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });

if (!globalForPrisma.prisma) {
  db.$on("warn" as never, (e: unknown) => log.warn("prisma-warning", { e }));
  db.$on("error" as never, (e: unknown) => log.error("prisma-error", { e }));
  // WAL: concurrent readers with serialized writer; safe across processes.
  db.$queryRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => undefined);
  db.$queryRawUnsafe("PRAGMA busy_timeout=8000;").catch(() => undefined);
  db.$queryRawUnsafe("PRAGMA foreign_keys=ON;").catch(() => undefined);
  globalForPrisma.prisma = db;
}
