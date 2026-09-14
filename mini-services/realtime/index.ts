// ============================================================
// Sada Realtime Service (spec §6) — socket.io gateway.
//  - JWT socket auth (60s tokens from /api/v1/auth/socket-token)
//  - Rooms: user:<id>, chat:<id> (+ channel subscribers)
//  - Full event protocol: MESSAGE_* , USER_*, CHAT_*, MEMBER_*, ADMIN_*
//  - Presence: in-memory (Redis adapter path documented for scale)
//  - Typing relay (ephemeral), delivery receipts, call signaling relay
//  - Internal emit API (HMAC, replay-protected) fed by the API services
//  - Tail-follower fallback: re-checks the Event table so no event is
//    ever silently lost if an internal emit fails (spec: never lose msgs)
// ============================================================
import { Server } from "socket.io";
import { createServer } from "http";
import { db } from "@/lib/db";
import { verifyToken } from "@/lib/server/jwt";
import { verifyInternalSignature } from "@/lib/server/security/signed-url";
import { env } from "@/lib/server/env";
import { Events } from "@/lib/shared/constants";

const PORT = Number(process.env.REALTIME_PORT || 3003);

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith("/internal/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "realtime", sockets: io.engine.clientsCount }));
    return;
  }
  // single request listener: the old structure had BOTH this callback and a
  // second httpServer.on("request") handler — the first one 404'd
  // /internal/emit before the second could run, so every instant push died
  // with ERR_HTTP_HEADERS_SENT and live delivery silently degraded to the
  // 4s tail-follower. Routing lives here now.
  if (req.method === "POST" && req.url?.startsWith("/internal/emit")) {
    handleInternalEmit(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 20000, // heartbeat (spec §6: ping/pong)
  pingTimeout: 25000,
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e6,
});

// ---------- event fan-out (chat members via user rooms) ----------
// MESSAGE_CREATED / CHANNEL_POSTED are delivered to the user:<id> room of
// EVERY current member — not the chat room. Reason: sockets only join
// chat rooms at connect/subscribe time, so a brand-new private chat would
// never push live to its recipient (they only discovered it via /sync on
// reconnect). User rooms always work; membership cache TTL 30s with the
// /sync cursor as the safety net for mid-TTL member changes.
const membersCache = new Map<string, { ids: string[]; ts: number }>();
async function membersOfChat(chatId: string): Promise<string[]> {
  const c = membersCache.get(chatId);
  if (c && Date.now() - c.ts < 30_000) return c.ids;
  const [mems, subs] = await Promise.all([
    db.chatMember.findMany({ where: { chatId, leftAt: null }, select: { userId: true } }),
    db.channelMember.findMany({ where: { chatId, leftAt: null }, select: { userId: true } }),
  ]);
  const ids = [...new Set([...mems.map((m) => m.userId), ...subs.map((s) => s.userId)])];
  membersCache.set(chatId, { ids, ts: Date.now() });
  return ids;
}

interface WireEvent {
  seq: number;
  type: string;
  chatId?: string | null;
  targetUserId?: string | null;
  actorId?: string | null;
  payloadJson?: string;
  payload?: unknown;
  createdAt?: string;
}

async function emitWire(wire: WireEvent) {
  if (wire.type === Events.MESSAGE_CREATED || wire.type === Events.CHANNEL_POSTED) {
    if (wire.chatId) {
      for (const uid of await membersOfChat(wire.chatId)) {
        io.to(`user:${uid}`).emit("event", wire);
      }
    } else if (wire.targetUserId) {
      io.to(`user:${wire.targetUserId}`).emit("event", wire);
    }
    return;
  }
  if (wire.chatId) io.to(`chat:${wire.chatId}`).emit("event", wire);
  if (wire.targetUserId) io.to(`user:${wire.targetUserId}`).emit("event", wire);
}

// ---------- presence (ephemeral, in-memory — spec §25) ----------
interface Presence {
  sockets: Map<string, Set<string>>; // userId → socketIds
  lastSeenFlush: Map<string, number>; // userId → ts (throttle DB writes)
  sharedChatsCache: Map<string, { userIds: string[]; ts: number }>;
}
const presence: Presence = {
  sockets: new Map(),
  lastSeenFlush: new Map(),
  sharedChatsCache: new Map(),
};

const PRESENCE_BROADCAST_CAP = 300;

async function chatIdsFor(userId: string): Promise<string[]> {
  const [members, subs] = await Promise.all([
    db.chatMember.findMany({ where: { userId, leftAt: null }, select: { chatId: true } }),
    db.channelMember.findMany({ where: { userId, leftAt: null }, select: { chatId: true } }),
  ]);
  return [...new Set([...members.map((m) => m.chatId), ...subs.map((s) => s.chatId)])];
}

/** Users who share at least one chat with me — presence audience. */
async function presenceAudience(userId: string): Promise<string[]> {
  const cached = presence.sharedChatsCache.get(userId);
  if (cached && Date.now() - cached.ts < 300_000) return cached.userIds;
  const chatIds = await chatIdsFor(userId);
  if (chatIds.length === 0) return [];
  const rows = await db.chatMember.findMany({
    where: { chatId: { in: chatIds.slice(0, 500) }, leftAt: null, userId: { not: userId } },
    select: { userId: true },
    distinct: ["userId"],
    take: PRESENCE_BROADCAST_CAP,
  });
  const userIds = rows.map((r) => r.userId);
  presence.sharedChatsCache.set(userId, { userIds, ts: Date.now() });
  return userIds;
}

function flushLastSeen(userId: string, force = false) {
  const last = presence.lastSeenFlush.get(userId) || 0;
  if (!force && Date.now() - last < 60_000) return; // throttle writes (spec §25)
  presence.lastSeenFlush.set(userId, Date.now());
  db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}

async function broadcastPresence(userId: string, online: boolean) {
  const audience = await presenceAudience(userId);
  const payload = { userId, at: new Date().toISOString() };
  for (const uid of audience) {
    io.to(`user:${uid}`).emit("event", {
      seq: 0, // presence is ephemeral — not part of the durable event log
      type: online ? Events.USER_ONLINE : Events.USER_OFFLINE,
      payload,
    });
  }
}

// ---------- connection auth ----------

io.use(async (socket, next) => {
  try {
    const token = (socket.handshake.auth?.token || socket.handshake.query?.token) as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    const payload = await verifyToken(token, "socket");
    if (!payload) return next(new Error("unauthorized"));
    const session = await db.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return next(new Error("session-revoked"));
    socket.data.userId = payload.sub;
    socket.data.sessionId = payload.sid;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", async (socket) => {
  const userId = socket.data.userId as string;
  socket.join(`user:${userId}`);

  // join all chat rooms
  try {
    const chatIds = await chatIdsFor(userId);
    for (const chatId of chatIds.slice(0, 1000)) socket.join(`chat:${chatId}`);
  } catch {
    /* join best-effort; sync API remains the fallback */
  }

  // presence: online
  const set = presence.sockets.get(userId) || new Set<string>();
  const wasOffline = set.size === 0;
  set.add(socket.id);
  presence.sockets.set(userId, set);
  if (wasOffline) {
    await broadcastPresence(userId, true);
    flushLastSeen(userId, true);
  }

  // ---- client → server events ----

  // typing indicator (ephemeral relay, spec §21)
  socket.on("typing", async (data: { chatId: string; isTyping: boolean }) => {
    if (!data?.chatId || typeof data.chatId !== "string") return;
    const member = await db.chatMember.findFirst({
      where: { chatId: data.chatId, userId, leftAt: null },
      select: { id: true },
    }).catch(() => null);
    if (!member) return; // must be a member to broadcast typing
    socket.to(`chat:${data.chatId}`).emit("event", {
      seq: 0,
      type: Events.USER_TYPING,
      chatId: data.chatId,
      payload: { chatId: data.chatId, userId, isTyping: !!data.isTyping },
    });
  });

  // delivery receipts (spec §24-25) — updates state + notifies chat
  socket.on("delivered", async (data: { chatId: string; upToSeq: number }) => {
    if (!data?.chatId || !Number.isFinite(data.upToSeq)) return;
    try {
      const member = await db.chatMember.findFirst({
        where: { chatId: data.chatId, userId, leftAt: null },
      });
      if (!member || data.upToSeq <= member.lastDeliveredSeq) return;
      await db.chatMember.update({
        where: { id: member.id },
        data: { lastDeliveredSeq: Math.min(data.upToSeq, 2_000_000_000) },
      });
      socket.to(`chat:${data.chatId}`).emit("event", {
        seq: 0,
        type: Events.MESSAGE_DELIVERED,
        chatId: data.chatId,
        payload: { chatId: data.chatId, userId, upToSeq: data.upToSeq },
      });
    } catch {
      /* delivery is best-effort; read receipts converge state */
    }
  });

  // subscribe late-joined chats (created after connect)
  socket.on("subscribe", async (data: { chatIds: string[] }) => {
    if (!Array.isArray(data?.chatIds)) return;
    for (const chatId of data.chatIds.slice(0, 50)) {
      if (typeof chatId !== "string") continue;
      const member = await db.chatMember.findFirst({
        where: { chatId, userId, leftAt: null }, select: { id: true },
      }).catch(() => null);
      if (member) socket.join(`chat:${chatId}`);
    }
  });

  // call signaling relay (WebRTC — calls-ready architecture, spec §113)
  const relayCall = async (event: string, data: { toUserId?: string; callId?: string }) => {
    if (!data?.toUserId || typeof data.toUserId !== "string") return;
    // must share a chat with the target
    const shared = await db.chatMember.findFirst({
      where: { userId, leftAt: null, chat: { members: { some: { userId: data.toUserId, leftAt: null } } } },
      select: { id: true },
    }).catch(() => null);
    if (!shared) return;
    io.to(`user:${data.toUserId}`).emit("event", {
      seq: 0,
      type: event,
      payload: { ...data, fromUserId: userId },
    });
  };
  socket.on("call:offer", (d) => relayCall(Events.CALL_OFFER, d));
  socket.on("call:answer", (d) => relayCall(Events.CALL_ANSWER, d));
  socket.on("call:ice", (d) => relayCall(Events.CALL_ICE, d));
  socket.on("call:end", (d) => relayCall(Events.CALL_END, d));

  socket.on("disconnect", () => {
    const set2 = presence.sockets.get(userId);
    if (set2) {
      set2.delete(socket.id);
      if (set2.size === 0) {
        presence.sockets.delete(userId);
        broadcastPresence(userId, false).catch(() => undefined);
        flushLastSeen(userId, true);
      }
    }
  });
});

// ---------- internal emit API (HMAC + replay protection) ----------

async function handleInternalEmit(req: any, res: any) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const ts = Number(req.headers["x-internal-ts"]);
  const sig = String(req.headers["x-internal-sig"] || "");
  if (!verifyInternalSignature(body, ts, sig)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "bad-signature" }));
    return;
  }
  let parsed: { events?: WireEvent[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  let delivered = 0;
  for (const ev of parsed.events || []) {
    let payload = ev.payload;
    if (payload === undefined && ev.payloadJson) {
      try {
        payload = JSON.parse(ev.payloadJson);
      } catch {
        payload = {};
      }
    }
    const wire = { seq: ev.seq, type: ev.type, chatId: ev.chatId, targetUserId: ev.targetUserId, actorId: ev.actorId, payload, createdAt: ev.createdAt };
    await emitWire(wire);
    delivered++;
    // advance the tail cursor: the 4s tail-follower must NOT re-broadcast
    // events that the instant push already delivered (duplicate emission)
    tailSeq = Math.max(tailSeq, ev.seq || 0);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, delivered }));
}

// tail-follower: durable-event fallback so emit failures never lose data
// (only re-broadcasts events the instant push missed — the cursor advances
// in handleInternalEmit too, so live-delivered events are never doubled)
let tailSeq = 0;

async function tailEvents() {
  try {
    if (tailSeq === 0) {
      const agg = await db.event.aggregate({ _max: { seq: true } });
      tailSeq = agg._max.seq || 0;
      return;
    }
    const rows = await db.event.findMany({ where: { seq: { gt: tailSeq } }, orderBy: { seq: "asc" }, take: 500 });
    for (const ev of rows) {
      tailSeq = Math.max(tailSeq, ev.seq);
      let payload = {};
      try {
        payload = JSON.parse(ev.payloadJson);
      } catch {
        /* ignore */
      }
      const wire = { seq: ev.seq, type: ev.type, chatId: ev.chatId, targetUserId: ev.targetUserId, actorId: ev.actorId, payload, createdAt: ev.createdAt };
      await emitWire(wire);
    }
  } catch {
    /* db busy — retry next tick */
  }
}

setInterval(tailEvents, 4000);

httpServer.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "realtime-up", port: PORT }));
});
