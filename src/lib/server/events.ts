// ============================================================
// Event log append + realtime fan-out (spec §6, §33).
// Every state change appends ordered events; the realtime service
// pushes them to live sockets; offline devices reconcile via /sync.
// ============================================================
import { db } from "@/lib/db";
import { env } from "./env";
import { internalSignature } from "./security/signed-url";
import { log } from "./logger";
import { Events, EventName } from "@/lib/shared/constants";

export interface NewEvent {
  type: EventName | string;
  chatId?: string | null;
  targetUserId?: string | null;
  actorId?: string | null;
  payload: unknown;
}

/** Persist events (ordered by autoincrement seq) then push to realtime. */
export async function appendAndEmit(events: NewEvent[]): Promise<number[]> {
  if (events.length === 0) return [];
  const rows = events.map((e) => ({
    type: e.type,
    chatId: e.chatId ?? null,
    targetUserId: e.targetUserId ?? null,
    actorId: e.actorId ?? null,
    payloadJson: JSON.stringify(e.payload ?? {}),
  }));
  const inserted: number[] = [];
  for (const row of rows) {
    const created = await db.event.create({ data: row, select: { seq: true } });
    inserted.push(created.seq);
  }
  // Fire-and-forget push — delivery is guaranteed for offline devices by
  // the /sync cursor reconciliation, so emit failure is non-fatal.
  pushToRealtime(
    rows.map((r, i) => ({ seq: inserted[i], ...r, createdAt: new Date().toISOString() }))
  ).catch((e) => log.warn("realtime-emit-failed", { err: String(e) }));
  return inserted;
}

async function pushToRealtime(events: unknown[]) {
  const body = JSON.stringify({ events });
  const ts = Math.floor(Date.now() / 1000);
  const sig = internalSignature(body, ts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${env.REALTIME_URL}/internal/emit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-ts": String(ts),
        "x-internal-sig": sig,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Extract @mentions from message text → usernames. */
export function extractMentions(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /@([a-zA-Z0-9_]{4,32})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

/** Extract http(s) URLs from message text. */
export function extractUrls(text: string | null): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  return [...new Set(text.match(re) || [])].slice(0, 3);
}
