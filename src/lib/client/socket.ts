"use client";
// ============================================================
// Realtime client (spec §6): authenticated socket.io connection,
// exponential backoff reconnect, offline sync reconciliation.
// Flow on reconnect:
//   1. get short-lived socket token
//   2. connect → subscribe chats
//   3. pull /sync?since=<cursor> → apply missed events
//   4. flush outbox (queued messages while offline)
// ============================================================
import { io, Socket } from "socket.io-client";
import { get, post } from "./api";
import { useStore, applyEventToStore } from "./store";
import type { ChatCard } from "@/lib/server/services/chats.service";
import type { MessageDTO } from "@/lib/server/services/messages.service";

const REALTIME_PORT = process.env.NEXT_PUBLIC_REALTIME_PORT || 3003;
const CURSOR_KEY = "sada.syncCursor";

let socket: Socket | null = null;
let reconnectAttempts = 0;
let outboxTimer: ReturnType<typeof setInterval> | null = null;

function cursor(): number {
  return parseInt(localStorage.getItem(CURSOR_KEY) || "0", 10);
}
function saveCursor(seq: number) {
  if (seq > cursor()) localStorage.setItem(CURSOR_KEY, String(seq));
}

export function getSocket(): Socket | null {
  return socket;
}

export async function connectRealtime() {
  if (socket?.connected) return;
  const store = useStore.getState();
  store.setConnectionState("connecting");

  try {
    const { token } = await get<{ token: string; realtimePort: number }>("auth/socket-token");

    socket = io(`/?XTransformPort=${REALTIME_PORT}`, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 30000, // exponential-ish backoff capped
      timeout: 10000,
    });

    socket.on("connect", async () => {
      reconnectAttempts = 0;
      useStore.getState().setConnectionState("online");
      // late-joined chats after reconnect
      const chatIds = useStore.getState().chats.map((c) => c.id);
      socket?.emit("subscribe", { chatIds });
      // offline reconciliation (spec §6 steps 4-6, §34)
      await reconcile();
      flushOutbox();
    });

    socket.on("disconnect", (reason) => {
      useStore.getState().setConnectionState("offline");
      if (reason === "io server disconnect") {
        // auth failure → re-auth with a fresh token
        setTimeout(() => connectRealtime(), 1500);
      }
    });

    socket.on("connect_error", (err) => {
      reconnectAttempts++;
      useStore.getState().setConnectionState("offline");
      if (reconnectAttempts > 3 && String(err?.message).includes("unauthorized")) {
        // token expired — refresh and retry
        setTimeout(() => connectRealtime().catch(() => undefined), 2000);
      }
    });

    socket.on("event", (ev: { seq: number; type: string; chatId?: string }) => {
      applyEventToStore(ev);
      if (ev.seq > 0) saveCursor(ev.seq);
      handleLiveEvent(ev);
    });
  } catch {
    useStore.getState().setConnectionState("offline");
    // retry with backoff
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts++);
    setTimeout(() => connectRealtime().catch(() => undefined), delay);
  }
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  if (outboxTimer) clearInterval(outboxTimer);
}

/** Pull missed events from the durable log and refresh affected chats. */
export async function reconcile() {
  try {
    const since = cursor();
    if (since === 0) {
      // fresh device: seed cursor from server, load current state
      const { cursor: latest } = await get<{ cursor: number }>("sync/cursor");
      saveCursor(latest);
      return;
    }
    const res = await get<{ events: Array<{ seq: number; type: string; chatId?: string }>; cursor: number; hasMore: boolean }>(
      `sync?since=${since}`
    );
    const affectedChats = new Set<string>();
    for (const ev of res.events) {
      applyEventToStore(ev);
      if (ev.chatId) affectedChats.add(ev.chatId);
    }
    saveCursor(res.cursor);
    for (const chatId of affectedChats) {
      await reloadChatMessages(chatId, false);
      reloadChatList().catch(() => undefined);
    }
  } catch {
    /* offline — retry on next connect */
  }
}

async function handleLiveEvent(ev: { seq: number; type: string; chatId?: string; payload?: Record<string, unknown> }) {
  const s = useStore.getState();
  switch (ev.type) {
    case "MESSAGE_CREATED":
    case "CHANNEL_POSTED": {
      if (!ev.chatId) break;
      const state = useStore.getState();
      if (state.activeChatId === ev.chatId) {
        await reloadChatMessages(ev.chatId, false);
        // auto-mark read when viewing
        const chat = state.chats.find((c) => c.id === ev.chatId);
        if (chat && chat.lastMessageSeq) {
          post(`chats/${ev.chatId}/read`, { upToSeq: chat.lastMessageSeq }).then(() => reloadChatList()).catch(() => undefined);
        }
      } else {
        reloadChatList().catch(() => undefined);
      }
      break;
    }
    case "MESSAGE_UPDATED": {
      if (ev.chatId && s.activeChatId === ev.chatId) reloadChatMessages(ev.chatId, false);
      break;
    }
    case "CHAT_UPDATED":
    case "MEMBER_ADDED":
    case "MEMBER_REMOVED":
    case "ADMIN_CHANGED":
    case "MESSAGE_READ":
    case "MESSAGE_DELIVERED": {
      reloadChatList().catch(() => undefined);
      if (ev.chatId && s.activeChatId === ev.chatId && ev.type === "MESSAGE_READ") {
        reloadChatMessages(ev.chatId, false).catch(() => undefined);
      }
      break;
    }
    default:
      break;
  }
}

export async function reloadChatList() {
  const s = useStore.getState();
  const chats = await get<ChatCard[]>(
    `chats?${s.folderId ? `folderId=${s.folderId}&` : ""}${s.showingArchived ? "archived=true" : ""}${s.searchQuery ? `&q=${encodeURIComponent(s.searchQuery)}` : ""}`
  );
  useStore.getState().setChats(chats);
  if (!s.me) {
    // first load: also fetch profile
    const me = await get<Record<string, unknown>>("users/me");
    useStore.getState().setMe(me as never);
  }
}

export async function reloadChatMessages(chatId: string, reset: boolean) {
  const s = useStore.getState();
  s.setLoadingMessages(true);
  try {
    const existing = s.messages[chatId] || [];
    const newestSeq = existing.length ? existing[existing.length - 1].seq : 0;
    if (reset || existing.length === 0) {
      const res = await get<{ items: MessageDTO[]; hasMore: boolean }>(`chats/${chatId}/messages?limit=50`);
      useStore.getState().setMessages(chatId, res.items, false);
      useStore.getState().setHasMore(chatId, res.hasMore);
      // pinned bar
      const pinned = await get<{ messageId: string; text: string | null }[]>(`chats/${chatId}/pinned`).catch(() => []);
      useStore.setState((st) => ({
        pinnedBar: { ...st.pinnedBar, [chatId]: pinned[pinned.length - 1] || null },
      }));
    } else {
      const res = await get<{ items: MessageDTO[]; hasMore: boolean }>(`chats/${chatId}/messages?after=${newestSeq}&limit=100`);
      if (res.items.length) useStore.getState().setMessages(chatId, res.items, true);
      useStore.getState().setHasMore(chatId, res.hasMore);
    }
  } finally {
    useStore.getState().setLoadingMessages(false);
  }
}

export async function loadOlderMessages(chatId: string) {
  const s = useStore.getState();
  const existing = s.messages[chatId] || [];
  if (!existing.length || !s.hasMore[chatId]) return false;
  const oldestSeq = existing[0].seq;
  const res = await get<{ items: MessageDTO[]; hasMore: boolean }>(`chats/${chatId}/messages?before=${oldestSeq}&limit=50`);
  useStore.getState().setMessages(chatId, res.items, true);
  useStore.getState().setHasMore(chatId, res.hasMore);
  return res.items.length > 0;
}

// ---------- outbox flush (offline → online, spec §34) ----------

export function queueMessage(item: {
  chatId: string;
  text: string;
  replyToId?: string;
  attachments?: Array<{ mediaId: string; kind: string; filename?: string; meta?: Record<string, unknown> }>;
  scheduledAt?: string;
}): string {
  const localKey = `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = useStore.getState();
  store.addToOutbox({
    localKey,
    chatId: item.chatId,
    text: item.text,
    replyToId: item.replyToId,
    attachments: item.attachments || [],
    createdAt: Date.now(),
    status: "pending",
    scheduledAt: item.scheduledAt,
  });
  // optimistic render
  store.upsertMessage(item.chatId, {
    id: localKey,
    seq: 9_000_000_000 + store.outbox.length,
    chatId: item.chatId,
    sender: store.me
      ? { id: store.me.id, displayName: store.me.displayName, username: store.me.username, avatarMediaId: store.me.avatarMediaId, avatarColor: store.me.avatarColor || 0 }
      : null,
    kind: item.attachments?.length ? "media" : "text",
    text: item.text || null,
    status: "pending",
    scheduledAt: item.scheduledAt || null,
    editedAt: null,
    createdAt: new Date().toISOString(),
    replyTo: null,
    forwardFromChatId: null,
    forwardOriginName: null,
    entities: null,
    meta: null,
    attachments: [],
    reactions: [],
    isPinned: false,
    seenByMe: true,
  } as unknown as MessageDTO);

  flushOutbox();
  return localKey;
}

let flushing = false;

export async function flushOutbox() {
  if (flushing || !useStore.getState().connectionState === false) {
    /* fallthrough */
  }
  if (flushing) return;
  flushing = true;
  try {
    const store = useStore.getState();
    for (const item of [...store.outbox]) {
      if (item.status === "sending") continue;
      store.updateOutbox(item.localKey, { status: "sending" });
      try {
        const res = await post<{ message: MessageDTO }>(`chats/${item.chatId}/messages`, {
          text: item.text || undefined,
          replyToId: item.replyToId || undefined,
          attachments: item.attachments.length ? item.attachments : undefined,
          clientMsgId: item.localKey,
          scheduledAt: item.scheduledAt || undefined,
        });
        const state = useStore.getState();
        state.removeFromOutbox(item.localKey);
        state.upsertMessage(item.chatId, res.message);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "FORBIDDEN" || code === "NOT_FOUND") {
          // permanent failure → mark failed for user retry/cancel
          useStore.getState().updateOutbox(item.localKey, { status: "failed" });
        } else {
          // transient → back to pending
          useStore.getState().updateOutbox(item.localKey, { status: "pending" });
          break;
        }
      }
    }
  } finally {
    flushing = false;
  }
}

export function startOutboxTimer() {
  if (outboxTimer) return;
  outboxTimer = setInterval(() => {
    const state = useStore.getState();
    if (state.connectionState === "online" && state.outbox.some((o) => o.status === "pending")) {
      flushOutbox();
    }
  }, 5000);
}

// typing emit with throttle
let lastTypingEmit = 0;
export function emitTyping(chatId: string, isTyping: boolean) {
  const now = Date.now();
  if (isTyping && now - lastTypingEmit < 2500) return;
  lastTypingEmit = now;
  socket?.emit("typing", { chatId, isTyping });
}

export function emitDelivered(chatId: string, upToSeq: number) {
  socket?.emit("delivered", { chatId, upToSeq });
}
