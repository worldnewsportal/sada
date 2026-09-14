// ============================================================
// Sync service (spec §6, §33, §34): offline reconciliation protocol.
// Each device tracks lastEventSeq; on reconnect it pulls all events
// since its cursor, scoped to its chats + user-targeted events.
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";

export async function getSyncEvents(userId: string, since: number, limit = 500) {
  if (since < 0 || !Number.isFinite(since)) throw ApiError.badRequest("Invalid cursor");

  const myChats = await db.chatMember.findMany({
    where: { userId, leftAt: null },
    select: { chatId: true },
  });
  const myChannels = await db.channelMember.findMany({
    where: { userId, leftAt: null },
    select: { chatId: true },
  });
  const chatIds = [...new Set([...myChats.map((c) => c.chatId), ...myChannels.map((c) => c.chatId)])];
  if (chatIds.length === 0) return { events: [], cursor: since, hasMore: false };

  const rows = await db.event.findMany({
    where: {
      seq: { gt: since },
      OR: [{ chatId: { in: chatIds } }, { targetUserId: userId }],
    },
    orderBy: { seq: "asc" },
    take: Math.min(limit, 1000),
  });

  return {
    events: rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      chatId: r.chatId,
      actorId: r.actorId,
      payload: JSON.parse(r.payloadJson),
      createdAt: r.createdAt.toISOString(),
    })),
    cursor: rows.length ? rows[rows.length - 1].seq : since,
    hasMore: rows.length >= Math.min(limit, 1000),
  };
}

/** Update device cursor (device-level sync position). */
export async function updateDeviceCursor(sessionId: string, seq: number) {
  await db.session.update({ where: { id: sessionId }, data: { lastEventSeq: seq } });
  return { ok: true };
}

/** Get current global event cursor (used after fresh login). */
export async function getLatestSeq(): Promise<number> {
  const agg = await db.event.aggregate({ _max: { seq: true } });
  return agg._max.seq || 0;
}

/** Prune old events (worker; retention window, spec §24: Redis not source of truth). */
export async function pruneEvents(retentionDays: number) {
  const res = await db.event.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - retentionDays * 86400_000) } },
  });
  return res.count;
}
