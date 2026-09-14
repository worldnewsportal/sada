// ============================================================
// Queue service — durable DB-backed job queue (spec §29).
// Production: docker-compose swaps in Redis/BullMQ (docs/scaling.md).
// API: enqueueJob(). Worker: claimJobs()/completeJob()/failJob().
// ============================================================
import { db } from "@/lib/db";
import { ulid } from "@/lib/ulid";
import { log } from "../logger";

export interface EnqueueOpts {
  runAt?: Date;
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
}

export async function enqueueJob(type: string, payload: Record<string, unknown>, opts: EnqueueOpts = {}) {
  try {
    return await db.job.create({
      data: {
        id: ulid(),
        type,
        payloadJson: JSON.stringify(payload),
        runAt: opts.runAt || new Date(),
        priority: opts.priority || 0,
        maxAttempts: opts.maxAttempts || 5,
        dedupeKey: opts.dedupeKey || null,
      },
    });
  } catch (e: unknown) {
    // dedupeKey unique violation → job already queued; not an error
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      return null;
    }
    throw e;
  }
}

/** Claim due jobs (atomic-ish: SQLite serializes writers across processes). */
export async function claimJobs(workerId: string, limit = 5) {
  const due = await db.job.findMany({
    where: { status: "queued", runAt: { lte: new Date() } },
    orderBy: [{ priority: "asc" }, { runAt: "asc" }],
    take: limit,
  });
  const claimed: Array<{ id: string; type: string; payloadJson: string; runAt: Date; maxAttempts: number; workerId: string }> = [];
  for (const job of due) {
    const res = await db.job.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", updatedAt: new Date() },
    });
    if (res.count === 1) {
      claimed.push({ ...job, workerId });
    }
  }
  return claimed;
}

export async function completeJob(jobId: string, result?: Record<string, unknown>) {
  await db.job.update({
    where: { id: jobId },
    data: { status: "done", resultJson: result ? JSON.stringify(result) : null, updatedAt: new Date() },
  });
}

export async function skipJob(jobId: string, reason: string) {
  await db.job.update({
    where: { id: jobId },
    data: { status: "skipped", lastError: reason, updatedAt: new Date() },
  });
}

export async function failJob(jobId: string, err: Error) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  const attempts = job.attempts + 1;
  const retriesLeft = attempts < job.maxAttempts;
  await db.job.update({
    where: { id: jobId },
    data: {
      status: retriesLeft ? "queued" : "failed",
      attempts,
      lastError: err.message.slice(0, 500),
      runAt: retriesLeft ? new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1000)) : undefined,
      updatedAt: new Date(),
    },
  });
  if (!retriesLeft) log.error("job-failed-final", { jobId, type: job.type, err: err.message });
}

/** Prune finished jobs older than N hours (called by cleanup schedule). */
export async function pruneFinishedJobs(olderThanHours = 24) {
  const res = await db.job.deleteMany({
    where: {
      status: { in: ["done", "failed", "skipped"] },
      updatedAt: { lt: new Date(Date.now() - olderThanHours * 3600_000) },
    },
  });
  return res.count;
}
