// ============================================================
// Sada Worker (spec §29) — background job processor.
// Expensive work NEVER blocks HTTP requests:
//   media.process (thumbnails/variants/blur) · media.transcode
//   link.preview · push.send · scheduled.send · cleanup
//   account.delete · event.retention
// Polls the durable Job queue with claim/complete/fail + backoff.
// Runs independently: scale workers horizontally (docs/scaling.md).
// ============================================================
import { claimJobs, completeJob, failJob, skipJob, pruneFinishedJobs, enqueueJob } from "@/lib/server/services/queue.service";
import { generateVariants, transcodeVideo, pruneUploadSessions } from "@/lib/server/services/media.service";
import { dispatchMessagePush } from "@/lib/server/services/notifications.service";
import { publishScheduledMessage } from "@/lib/server/services/messages.service";
import { pruneEvents } from "@/lib/server/services/sync.service";
import { fetchLinkPreview } from "./src/handlers/link-preview";
import { processAccountDeletion } from "./src/handlers/account-delete";
import { log } from "@/lib/server/logger";

const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);
const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

type Handler = (payload: Record<string, unknown>, job: { id: string }) => Promise<Record<string, unknown> | { skipped: true; reason?: string }>;

const handlers: Record<string, Handler> = {
  "media.process": async (p) => {
    const res = await generateVariants(String(p.mediaId));
    if ("skipped" in res && res.skipped) return { skipped: true, reason: res.reason } as never;
    return res as Record<string, unknown>;
  },
  "media.transcode": async (p) => {
    const res = await transcodeVideo(String(p.mediaId));
    if ("skipped" in res && res.skipped) return { skipped: true, reason: res.reason } as never;
    return res as Record<string, unknown>;
  },
  "link.preview": async (p) => {
    const res = await fetchLinkPreview(String(p.messageId), String(p.url));
    if ("skipped" in res && res.skipped) return { skipped: true, reason: res.reason } as never;
    return res as Record<string, unknown>;
  },
  "push.send": async (p) => dispatchMessagePush(String(p.messageId), String(p.chatId), (p.senderId as string) || null),
  "scheduled.send": async (p) => {
    const res = await publishScheduledMessage(String(p.messageId));
    if ("skipped" in res && res.skipped) return { skipped: true } as never;
    return res as Record<string, unknown>;
  },
  "account.delete": async (p) => processAccountDeletion(String(p.userId)),
  cleanup: async () => {
    const jobsPruned = await pruneFinishedJobs(24);
    const uploadsPruned = await pruneUploadSessions();
    const eventsPruned = await pruneEvents(Number(process.env.EVENT_RETENTION_DAYS || 7));
    return { jobsPruned, uploadsPruned, eventsPruned };
  },
};

let running = true;
let lastCleanupAt = 0;

async function tick() {
  if (!running) return;
  try {
    // periodic cleanup scheduling (hourly)
    if (Date.now() - lastCleanupAt > 3600_000) {
      lastCleanupAt = Date.now();
      await enqueueJob("cleanup", {}, { dedupeKey: `cleanup-${new Date().toISOString().slice(0, 13)}` });
    }

    const jobs = await claimJobs(WORKER_ID, 5);
    for (const job of jobs) {
      const started = Date.now();
      const handler = handlers[job.type];
      try {
        if (!handler) {
          await skipJob(job.id, `no handler for type ${job.type}`);
          continue;
        }
        const payload = JSON.parse(job.payloadJson || "{}") as Record<string, unknown>;
        const result = await handler(payload, job);
        await completeJob(job.id, result as Record<string, unknown>);
        log.info("job-done", { jobId: job.id, type: job.type, ms: Date.now() - started, result: JSON.stringify(result).slice(0, 200) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("job-skip:")) {
          await skipJob(job.id, message.replace("job-skip:", "").trim());
        } else {
          await failJob(job.id, err instanceof Error ? err : new Error(String(err)));
          log.warn("job-failed", { jobId: job.id, type: job.type, err: message });
        }
      }
    }
  } catch (err) {
    log.warn("worker-tick-error", { err: String(err) });
  }
}

async function main() {
  log.info("worker-up", { workerId: WORKER_ID, pollMs: POLL_MS });
  // loop
  while (running) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

process.on("SIGINT", () => {
  running = false;
  process.exit(0);
});
process.on("SIGTERM", () => {
  running = false;
  process.exit(0);
});

main();
