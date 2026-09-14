"use client";
// ============================================================
// Zustand store — client state (auth, chats, messages, presence,
// typing, UI). Optimistic sends + outbox for offline (spec §14, §34).
// ============================================================
import { create } from "zustand";
import { Events } from "@/lib/shared/constants";
import type { ChatCard } from "@/lib/server/services/chats.service";
import type { MessageDTO } from "@/lib/server/services/messages.service";

export interface OutboxItem {
  localKey: string;
  chatId: string;
  text: string;
  replyToId?: string;
  attachments: Array<{ mediaId: string; kind: string; filename?: string; meta?: Record<string, unknown> }>;
  createdAt: number;
  status: "pending" | "sending" | "failed";
  scheduledAt?: string;
}

export interface CallState {
  active: boolean;
  peerId?: string;
  peerName?: string;
  callId?: string;
  incoming?: boolean;
  video?: boolean;
  state: "ringing" | "connecting" | "connected" | "ended";
  screenShare?: boolean;
  pendingOffer?: RTCSessionDescriptionInit;
}

interface MessengerState {
  // auth
  me: { id: string; displayName: string; username: string | null; avatarMediaId: string | null; phone?: string; avatarColor?: number } | null;
  authChecked: boolean;
  setMe: (me: MessengerState["me"]) => void;

  // chats
  chats: ChatCard[];
  chatsLoading: boolean;
  folderId: string | null;
  showingArchived: boolean;
  searchQuery: string;
  setChats: (chats: ChatCard[]) => void;
  setChatsLoading: (v: boolean) => void;
  setFolderId: (id: string | null) => void;
  setShowingArchived: (v: boolean) => void;
  setSearchQuery: (q: string) => void;
  upsertChat: (chat: ChatCard) => void;

  // messages
  activeChatId: string | null;
  messages: Record<string, MessageDTO[]>;
  hasMore: Record<string, boolean>;
  loadingMessages: boolean;
  setActiveChat: (id: string | null) => void;
  setMessages: (chatId: string, msgs: MessageDTO[], append?: boolean) => void;
  setHasMore: (chatId: string, hasMore: boolean) => void;
  setLoadingMessages: (v: boolean) => void;
  upsertMessage: (chatId: string, msg: MessageDTO) => void;
  removeMessage: (chatId: string, messageId: string) => void;
  updateReactions: (chatId: string, messageId: string, reactions: MessageDTO["reactions"]) => void;

  // outbox (offline queue)
  outbox: OutboxItem[];
  addToOutbox: (item: OutboxItem) => void;
  updateOutbox: (localKey: string, patch: Partial<OutboxItem>) => void;
  removeFromOutbox: (localKey: string) => void;

  // presence & typing (ephemeral)
  onlineUsers: Set<string>;
  typing: Record<string, Record<string, number>>; // chatId → userId → ts
  setOnline: (userId: string, online: boolean) => void;
  setTyping: (chatId: string, userId: string, isTyping: boolean) => void;

  // pinned message bar
  pinnedBar: Record<string, { messageId: string; text: string | null } | null>;

  // unread notifications
  unreadNotifications: number;
  setUnreadNotifications: (n: number) => void;

  // calls
  call: CallState | null;
  setCall: (call: CallState | null) => void;

  // ui
  view: string; // chats | contacts | search | settings | admin | media-viewer | folder-manage
  viewParam?: string;
  setView: (view: string, param?: string) => void;
  connectionState: "connecting" | "online" | "offline";
  setConnectionState: (s: MessengerState["connectionState"]) => void;
  locale: "ar" | "en";
  setLocale: (l: "ar" | "en") => void;
}

export const useStore = create<MessengerState>((set, get) => ({
  me: null,
  authChecked: false,
  setMe: (me) => set({ me, authChecked: true }),

  chats: [],
  chatsLoading: false,
  folderId: null,
  showingArchived: false,
  searchQuery: "",
  setChats: (chats) => set({ chats }),
  setChatsLoading: (chatsLoading) =>
    set((s) => (s.chatsLoading === chatsLoading ? s : { chatsLoading })),
  setFolderId: (folderId) => set({ folderId }),
  setShowingArchived: (showingArchived) => set({ showingArchived }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  upsertChat: (chat) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.id === chat.id);
      const chats = idx >= 0 ? s.chats.map((c, i) => (i === idx ? chat : c)) : [chat, ...s.chats];
      return { chats };
    }),

  activeChatId: null,
  messages: {},
  hasMore: {},
  loadingMessages: false,
  setActiveChat: (activeChatId) => set({ activeChatId }),
  setMessages: (chatId, msgs, append) =>
    set((s) => {
      const existing = append ? s.messages[chatId] || [] : [];
      const map = new Map<string, MessageDTO>();
      for (const m of existing) map.set(m.id, m);
      for (const m of msgs) map.set(m.id, m);
      const merged = [...map.values()].sort((a, b) => a.seq - b.seq);
      return { messages: { ...s.messages, [chatId]: merged } };
    }),
  setHasMore: (chatId, hasMore) =>
    set((s) => (s.hasMore[chatId] === hasMore ? s : { hasMore: { ...s.hasMore, [chatId]: hasMore } })),
  setLoadingMessages: (loadingMessages) =>
    set((s) => (s.loadingMessages === loadingMessages ? s : { loadingMessages })),
  upsertMessage: (chatId, msg) =>
    set((s) => {
      const existing = s.messages[chatId] || [];
      const map = new Map(existing.map((m) => [m.id, m]));
      map.set(msg.id, msg);
      const sorted = [...map.values()].sort((a, b) => a.seq - b.seq);
      return { messages: { ...s.messages, [chatId]: sorted } };
    }),
  removeMessage: (chatId, messageId) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: (s.messages[chatId] || []).map((m) =>
          m.id === messageId ? { ...m, status: "deleted", text: null, attachments: [] } : m
        ),
      },
    })),
  updateReactions: (chatId, messageId, reactions) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [chatId]: (s.messages[chatId] || []).map((m) => (m.id === messageId ? { ...m, reactions } : m)),
      },
    })),

  outbox: [],
  addToOutbox: (item) => set((s) => ({ outbox: [...s.outbox, item] })),
  updateOutbox: (localKey, patch) =>
    set((s) => ({ outbox: s.outbox.map((o) => (o.localKey === localKey ? { ...o, ...patch } : o)) })),
  removeFromOutbox: (localKey) => set((s) => ({ outbox: s.outbox.filter((o) => o.localKey !== localKey) })),

  onlineUsers: new Set<string>(),
  typing: {},
  // no-op guards: presence/typing events arrive in bursts (connect, sync,
  // receipts). Re-creating the Set/Record on redundant events churns object
  // identity → every subscriber's getSnapshot returns a fresh reference
  // mid-render → React 19 useSyncExternalStore "getSnapshot should be
  // cached" infinite loop. Returning the SAME state object makes zustand's
  // Object.is check skip notification entirely.
  setOnline: (userId, online) =>
    set((s) => {
      if (s.onlineUsers.has(userId) === online) return s;
      const next = new Set(s.onlineUsers);
      if (online) next.add(userId);
      else next.delete(userId);
      return { onlineUsers: next };
    }),
  setTyping: (chatId, userId, isTyping) =>
    set((s) => {
      if ((userId in (s.typing[chatId] || {})) === isTyping) return s;
      const chatTyping = { ...(s.typing[chatId] || {}) };
      if (isTyping) chatTyping[userId] = Date.now();
      else delete chatTyping[userId];
      return { typing: { ...s.typing, [chatId]: chatTyping } };
    }),

  pinnedBar: {},
  unreadNotifications: 0,
  setUnreadNotifications: (unreadNotifications) =>
    set((s) => (s.unreadNotifications === unreadNotifications ? s : { unreadNotifications })),

  call: null,
  setCall: (call) => set({ call }),

  view: "chats",
  viewParam: undefined,
  setView: (view, viewParam) => set({ view, viewParam }),
  connectionState: "connecting",
  // reconnect storms fire connect/disconnect repeatedly — skip no-op writes
  // so the state object identity only changes on a real transition.
  setConnectionState: (connectionState) =>
    set((s) => (s.connectionState === connectionState ? s : { connectionState })),
  locale: "ar",
  setLocale: (locale) => set({ locale }),
}));

// ---- event application (socket events → store) ----

export function applyEventToStore(ev: {
  seq: number;
  type: string;
  chatId?: string | null;
  payload?: Record<string, unknown>;
}) {
  const s = useStore.getState();
  switch (ev.type) {
    case Events.USER_ONLINE:
      if (ev.payload?.userId) s.setOnline(ev.payload.userId as string, true);
      break;
    case Events.USER_OFFLINE:
      if (ev.payload?.userId) s.setOnline(ev.payload.userId as string, false);
      break;
    case Events.USER_TYPING:
      if (ev.chatId && ev.payload?.userId) {
        s.setTyping(ev.chatId, ev.payload.userId as string, !!ev.payload.isTyping);
      }
      break;
    case Events.MESSAGE_DELETED:
      if (ev.chatId && ev.payload?.messageId) {
        s.removeMessage(ev.chatId, ev.payload.messageId as string);
      }
      break;
    case Events.MESSAGE_REACTION_UPDATED:
      if (ev.chatId && ev.payload?.messageId && ev.payload?.reactions) {
        s.updateReactions(ev.chatId, ev.payload.messageId as string, ev.payload.reactions as MessageDTO["reactions"]);
      }
      break;
    case Events.MESSAGE_PINNED:
      if (ev.chatId) {
        s.pinnedBar[ev.chatId] = ev.payload?.pinned
          ? { messageId: ev.payload.messageId as string, text: (ev.payload.text as string) || null }
          : null;
      }
      break;
    case Events.NOTIFICATION_CREATED:
      s.setUnreadNotifications(s.unreadNotifications + 1);
      break;
    default:
      // MESSAGE_CREATED / MESSAGE_UPDATED / CHAT_UPDATED / MEMBER_* — handled
      // by the chat refresh flow in socket.ts to keep a single fetch path.
      break;
  }
}
