// ============================================================
// Chats service — private/group/channel/saved chats, membership,
// granular permissions, invites, join requests, folders, pins,
// archive, mute, read state, drafts (spec §1, §20, §21, §66-71).
// SERVER-SIDE authorization on every privileged op (spec §16).
// ============================================================
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { ApiError } from "../errors";
import { ulid } from "@/lib/ulid";
import { Limits, ChatType, ROLE_DEFAULTS, PermissionSet } from "@/lib/shared/constants";
import { enforceRateLimit } from "../security/rate-limit";
import { appendAndEmit, extractMentions } from "../events";
import { Events } from "@/lib/shared/constants";
import { appendAudit } from "./audit.service";
import { isBlockedEitherWay, projectUser } from "./users.service";
import { log } from "../logger";

export interface ChatCard {
  id: string;
  type: ChatType;
  title: string;
  username: string | null;
  about: string | null;
  avatarMediaId: string | null;
  isPublic: boolean;
  memberCount: number;
  role: string;
  perms: PermissionSet;
  unreadCount: number;
  mentionCount: number;
  lastReadSeq: number;
  mutedUntil: Date | null;
  archived: boolean;
  pinned: boolean;
  pinnedOrder: number;
  lastMessageAt: Date | null;
  lastMessageSeq: number;
  lastMsgPreview: { kind: string; text: string; senderName?: string; editedAt?: string } | null;
  peer: ReturnType<typeof projectUser> | null;
  draft?: string;
  canPost: boolean;
  slowModeSeconds: number;
  discussionChatId: string | null;
}

export function resolvePerms(role: string, override: string | null, chatDefault: string | null): PermissionSet {
  const base = { ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.member) };
  if (chatDefault && role === "member") {
    try {
      Object.assign(base, JSON.parse(chatDefault));
    } catch {
      /* ignore malformed */
    }
  }
  if (override) {
    try {
      Object.assign(base, JSON.parse(override));
    } catch {
      /* ignore malformed */
    }
  }
  return base;
}

// ---------- listing ----------

export async function listChats(userId: string, opts: { folderId?: string; archived?: boolean; query?: string } = {}) {
  const where: Record<string, unknown> = {
    userId,
    leftAt: null,
    archived: opts.archived ?? false,
  };
  if (opts.folderId) {
    const entries = await db.folderChat.findMany({ where: { folderId: opts.folderId }, select: { chatId: true } });
    where.chatId = { in: entries.map((e) => e.chatId) };
  }
  const memberships = await db.chatMember.findMany({
    where,
    orderBy: [{ pinned: "desc" }, { pinnedOrder: "asc" }],
    include: {
      chat: { include: { messages: { where: { status: { not: "deleted" } }, orderBy: { seq: "desc" }, take: 1, select: { seq: true, createdAt: true } } } },
    },
  });

  // load peers for private chats in one query
  const privateChatIds = memberships.filter((m) => m.chat.type === "private").map((m) => m.chatId);
  const peerRows = privateChatIds.length
    ? await db.chatMember.findMany({
        where: { chatId: { in: privateChatIds }, userId: { not: userId }, leftAt: null },
        include: { user: { include: { privacy: true } } },
      })
    : [];
  const peerByChat = new Map(peerRows.map((p) => [p.chatId, p]));

  let cards = memberships.map((m): ChatCard => {
    const chat = m.chat;
    const peerMember = peerByChat.get(chat.id);
    const isPrivate = chat.type === "private";
    const peer = peerMember ? projectUser(peerMember.user, peerMember.user.privacy, userId, false) : null;
    const perms = resolvePerms(m.role, m.permsOverride, chat.defaultPerms);
    const canPost =
      chat.type === "channel" ? perms.canPostMessages : chat.type === "private" ? true : perms.canPostMessages;
    return {
      id: chat.id,
      type: chat.type as ChatType,
      title: isPrivate ? peer?.displayName || "Deleted account" : chat.title || "Chat",
      username: chat.username,
      about: chat.about,
      avatarMediaId: isPrivate ? peer?.avatarMediaId ?? null : chat.avatarMediaId,
      isPublic: chat.isPublic,
      memberCount: chat.memberCount,
      role: m.role,
      perms,
      unreadCount: m.unreadCount,
      mentionCount: m.mentionCount,
      lastReadSeq: m.lastReadSeq,
      mutedUntil: m.mutedUntil,
      archived: m.archived,
      pinned: m.pinned,
      pinnedOrder: m.pinnedOrder,
      lastMessageAt: chat.lastMessageAt,
      lastMessageSeq: chat.lastMessageSeq,
      lastMsgPreview: chat.lastMsgPreview ? JSON.parse(chat.lastMsgPreview) : null,
      peer,
      canPost,
      slowModeSeconds: chat.slowModeSeconds,
      discussionChatId: chat.discussionChatId,
    };
  });

  if (opts.query) {
    const q = opts.query.toLowerCase();
    cards = cards.filter((c) => c.title.toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q));
  }
  return cards;
}

export async function getChatCard(userId: string, chatId: string): Promise<ChatCard> {
  const m = await db.chatMember.findFirst({
    where: { chatId, userId, leftAt: null },
    include: { chat: true },
  });
  if (!m) throw ApiError.notFound("Chat not found");
  const chat = m.chat;
  let peer = null as ChatCard["peer"];
  if (chat.type === "private") {
    const peerMember = await db.chatMember.findFirst({
      where: { chatId, userId: { not: userId }, leftAt: null },
      include: { user: { include: { privacy: true } } },
    });
    if (peerMember) peer = projectUser(peerMember.user, peerMember.user.privacy, userId, false);
  }
  const perms = resolvePerms(m.role, m.permsOverride, chat.defaultPerms);
  const draft = await db.draft.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  return {
    id: chat.id,
    type: chat.type as ChatType,
    title: chat.type === "private" ? peer?.displayName || "Deleted account" : chat.title || "Chat",
    username: chat.username,
    about: chat.about,
    avatarMediaId: chat.type === "private" ? peer?.avatarMediaId ?? null : chat.avatarMediaId,
    isPublic: chat.isPublic,
    memberCount: chat.memberCount,
    role: m.role,
    perms,
    unreadCount: m.unreadCount,
    mentionCount: m.mentionCount,
    lastReadSeq: m.lastReadSeq,
    mutedUntil: m.mutedUntil,
    archived: m.archived,
    pinned: m.pinned,
    pinnedOrder: m.pinnedOrder,
    lastMessageAt: chat.lastMessageAt,
    lastMessageSeq: chat.lastMessageSeq,
    lastMsgPreview: chat.lastMsgPreview ? JSON.parse(chat.lastMsgPreview) : null,
    peer,
    draft: draft?.text || "",
    canPost: chat.type === "channel" ? perms.canPostMessages : chat.type === "private" ? true : perms.canPostMessages,
    slowModeSeconds: chat.slowModeSeconds,
    discussionChatId: chat.discussionChatId,
  };
}

/** Membership + permission guard used by messages service too. */
export async function requireMembership(userId: string, chatId: string) {
  const m = await db.chatMember.findFirst({
    where: { chatId, userId, leftAt: null },
    include: { chat: true },
  });
  if (!m) throw ApiError.forbidden("Not a member of this chat");
  if (m.bannedUntil && m.bannedUntil > new Date()) throw ApiError.forbidden("You are restricted in this chat");
  return m;
}

export function requirePerm(perms: PermissionSet, key: keyof PermissionSet) {
  if (!perms[key]) throw ApiError.forbidden(`Missing permission: ${key}`);
}

// ---------- creation ----------

async function assertUsernameAvailable(username: string | null | undefined) {
  if (!username) return;
  if (!/^[a-zA-Z0-9_]{4,32}$/.test(username)) throw ApiError.badRequest("Invalid username");
  const exists = await db.chat.findUnique({ where: { username: username.toLowerCase() } });
  if (exists) throw ApiError.conflict("USERNAME_TAKEN", "Link already taken");
}

export async function createPrivateChat(userId: string, peerId: string) {
  if (userId === peerId) return getOrCreateSavedChat(userId);
  const peer = await db.user.findUnique({ where: { id: peerId } });
  if (!peer || peer.deletedAt) throw ApiError.notFound("User not found");
  if (await isBlockedEitherWay(userId, peerId)) throw ApiError.forbidden("Cannot start chat with this user");

  // whoCanMessageMe policy (spec §57-62)
  const privacy = await db.userPrivacy.findUnique({ where: { userId: peerId } });
  if (privacy && privacy.whoCanMessageMe === "nobody") throw ApiError.forbidden("This user does not accept new chats");
  if (privacy?.whoCanMessageMe === "contacts") {
    const contact = await db.contact.findFirst({ where: { ownerId: peerId, contactUserId: userId } });
    if (!contact) throw ApiError.forbidden("This user only accepts chats from contacts");
  }

  // get-or-create deterministic pair
  const mine = await db.chatMember.findMany({
    where: { userId, leftAt: null, chat: { type: "private" } },
    select: { chatId: true },
  });
  const theirs = await db.chatMember.findMany({
    where: { userId: peerId, leftAt: null, chat: { type: "private" } },
    select: { chatId: true },
  });
  const mineSet = new Set(mine.map((x) => x.chatId));
  const shared = theirs.find((x) => mineSet.has(x.chatId));
  if (shared) return getChatCard(userId, shared.chatId);

  const chatId = ulid();
  await db.$transaction([
    db.chat.create({ data: { id: chatId, type: "private", memberCount: 2 } }),
    db.chatMember.create({ data: { id: ulid(), chatId, userId } }),
    db.chatMember.create({ data: { id: ulid(), chatId, userId: peerId } }),
  ]);
  return getChatCard(userId, chatId);
}

export async function getOrCreateSavedChat(userId: string) {
  const existing = await db.chat.findFirst({
    where: { type: "saved", members: { some: { userId, leftAt: null } } },
  });
  if (existing) return getChatCard(userId, existing.id);
  const chatId = ulid();
  await db.$transaction([
    db.chat.create({ data: { id: chatId, type: "saved", title: "Saved Messages", memberCount: 1 } }),
    db.chatMember.create({ data: { id: ulid(), chatId, userId, role: "owner" } }),
  ]);
  return getChatCard(userId, chatId);
}

export interface CreateGroupInput {
  title: string;
  about?: string;
  memberIds?: string[];
  type?: "group" | "channel";
  isPublic?: boolean;
  username?: string;
  requireApproval?: boolean;
}

export async function createGroupOrChannel(userId: string, input: CreateGroupInput) {
  const type = input.type === "channel" ? "channel" : "group";
  enforceRateLimit(type === "channel" ? "chats:create-channel" : "chats:create-group", userId);

  const title = input.title.trim();
  if (title.length < 1 || title.length > Limits.MAX_CHAT_NAME) {
    throw ApiError.badRequest(`Name must be 1-${Limits.MAX_CHAT_NAME} characters`);
  }
  if (input.about && input.about.length > Limits.MAX_ABOUT) throw ApiError.badRequest("About too long");
  await assertUsernameAvailable(input.username);
  if (input.isPublic && !input.username) throw ApiError.badRequest("Public chats require a username link");

  const memberIds = [...new Set(input.memberIds || [])].filter((id) => id !== userId).slice(0, Limits.MAX_GROUP_BASIC);
  const users = memberIds.length
    ? await db.user.findMany({ where: { id: { in: memberIds }, deletedAt: null } })
    : [];

  const chatId = ulid();
  const defaultPerms = JSON.stringify({
    ...ROLE_DEFAULTS.member,
    ...(type === "channel" ? { canPostMessages: false } : {}),
    ...(input.requireApproval ? { requireApproval: true } : {}),
  });

  const ops: Prisma.PrismaPromise<unknown>[] = [
    db.chat.create({
      data: {
        id: chatId,
        type,
        title,
        about: input.about || null,
        username: input.username?.toLowerCase() || null,
        isPublic: !!input.isPublic,
        ownerId: userId,
        defaultPerms,
        memberCount: users.length + 1,
      },
    }),
    db.chatMember.create({ data: { id: ulid(), chatId, userId, role: "owner" } }),
  ];
  for (const u of users) {
    ops.push(db.chatMember.create({ data: { id: ulid(), chatId, userId: u.id } }));
  }
  ops.push(
    db.message.create({
      data: {
        id: ulid(),
        seq: await nextSeq(),
        chatId,
        senderId: null,
        kind: "system",
        text: type === "channel" ? `Channel "${title}" created` : `Group "${title}" created`,
        meta: JSON.stringify({ systemType: "chat_created", actorName: "" }),
      },
    })
  );
  await db.$transaction(ops);
  await db.chat.update({
    where: { id: chatId },
    data: { lastMessageAt: new Date(), lastMessageSeq: 1, lastMsgPreview: JSON.stringify({ kind: "system", text: "Chat created" }) },
  });

  const events = users.map((u) => ({
    type: Events.MEMBER_ADDED,
    targetUserId: u.id,
    chatId,
    actorId: userId,
    payload: { chatId, userId: u.id },
  }));
  await appendAndEmit(events);
  await appendAudit({ actorType: "user", actorId: userId, action: `chat.${type}_created`, targetType: "chat", targetId: chatId });

  return getChatCard(userId, chatId);
}

let seqMutex: Promise<number> = Promise.resolve(0);

/** Transactional global message-seq allocation (SQLite serializes writers). */
export async function nextSeq(): Promise<number> {
  const run = async (): Promise<number> => {
    const agg = await db.message.aggregate({ _max: { seq: true } });
    return (agg._max.seq || 0) + 1;
  };
  const p = seqMutex.then(run);
  seqMutex = p.catch(() => 0);
  return p;
}

// ---------- membership management ----------

export async function addMembers(actorId: string, chatId: string, memberIds: string[]) {
  const me = await requireMembership(actorId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canInviteMembers");

  const ids = [...new Set(memberIds)].slice(0, 100);
  const users = await db.user.findMany({ where: { id: { in: ids }, deletedAt: null } });
  const added: string[] = [];
  for (const u of users) {
    const existing = await db.chatMember.findUnique({ where: { chatId_userId: { chatId, userId: u.id } } });
    if (existing) {
      if (existing.leftAt) {
        await db.chatMember.update({ where: { id: existing.id }, data: { leftAt: null, role: "member" } });
        added.push(u.id);
      }
      continue;
    }
    await db.chatMember.create({ data: { id: ulid(), chatId, userId: u.id, invitedBy: actorId } });
    added.push(u.id);
  }
  if (added.length) {
    await db.chat.update({ where: { id: chatId }, data: { memberCount: { increment: added.length } } });
    const actor = await db.user.findUnique({ where: { id: actorId } });
    await appendAndEmit(
      added.map((uid) => ({
        type: Events.MEMBER_ADDED,
        chatId,
        targetUserId: uid,
        actorId,
        payload: { chatId, userId: uid, byName: actor?.displayName },
      }))
    );
  }
  return { added: added.length };
}

export async function removeMember(actorId: string, chatId: string, targetId: string) {
  const me = await requireMembership(actorId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canRestrictMembers");
  if (me.chat.ownerId === targetId) throw ApiError.forbidden("Cannot remove the owner");

  const target = await db.chatMember.findFirst({ where: { chatId, userId: targetId, leftAt: null } });
  if (!target) throw ApiError.notFound("Member not found");
  if (target.role === "owner" || (target.role === "admin" && me.role !== "owner")) {
    throw ApiError.forbidden("Insufficient role to remove this member");
  }
  await db.chatMember.update({ where: { id: target.id }, data: { leftAt: new Date() } });
  await db.chat.update({ where: { id: chatId }, data: { memberCount: { decrement: 1 } } });
  await appendAndEmit([
    { type: Events.MEMBER_REMOVED, chatId, actorId, payload: { chatId, userId: targetId } },
    { type: Events.MEMBER_REMOVED, targetUserId: targetId, chatId, actorId, payload: { chatId, userId: targetId } },
  ]);
  return { removed: true };
}

export async function setMemberRole(actorId: string, chatId: string, targetId: string, role: string) {
  const me = await requireMembership(actorId, chatId);
  if (me.chat.ownerId !== actorId) throw ApiError.forbidden("Only the owner can change roles");
  if (!["admin", "moderator", "member", "restricted"].includes(role)) throw ApiError.badRequest("Invalid role");
  if (me.chat.ownerId === targetId) throw ApiError.badRequest("Cannot change the owner's role");

  const target = await db.chatMember.findFirst({ where: { chatId, userId: targetId, leftAt: null } });
  if (!target) throw ApiError.notFound("Member not found");
  await db.chatMember.update({ where: { id: target.id }, data: { role } });
  await appendAndEmit([{ type: Events.ADMIN_CHANGED, chatId, actorId, payload: { chatId, userId: targetId, role } }]);
  await appendAudit({ actorType: "user", actorId, action: "chat.role_changed", targetType: "chat", targetId: chatId, detailJson: JSON.stringify({ targetId, role }) });
  return { ok: true };
}

export async function setMemberPerms(actorId: string, chatId: string, targetId: string, permsDelta: Partial<PermissionSet>) {
  const me = await requireMembership(actorId, chatId);
  if (me.chat.ownerId !== actorId) throw ApiError.forbidden("Only the owner can set custom permissions");
  const target = await db.chatMember.findFirst({ where: { chatId, userId: targetId, leftAt: null } });
  if (!target) throw ApiError.notFound("Member not found");
  const merged = { ...(target.permsOverride ? JSON.parse(target.permsOverride) : {}), ...permsDelta };
  await db.chatMember.update({ where: { id: target.id }, data: { permsOverride: JSON.stringify(merged) } });
  await appendAndEmit([{ type: Events.ADMIN_CHANGED, chatId, actorId, payload: { chatId, userId: targetId, perms: merged } }]);
  return { ok: true };
}

export async function restrictMember(actorId: string, chatId: string, targetId: string, untilDate: Date | null) {
  const me = await requireMembership(actorId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canRestrictMembers");
  const target = await db.chatMember.findFirst({ where: { chatId, userId: targetId, leftAt: null } });
  if (!target) throw ApiError.notFound("Member not found");
  if (target.role === "owner") throw ApiError.forbidden("Cannot restrict the owner");
  await db.chatMember.update({ where: { id: target.id }, data: { bannedUntil: untilDate, role: untilDate ? "restricted" : "member" } });
  await appendAndEmit([
    { type: Events.ADMIN_CHANGED, chatId, actorId, payload: { chatId, userId: targetId, restrictedUntil: untilDate } },
  ]);
  return { ok: true };
}

export async function listMembers(userId: string, chatId: string, opts: { limit?: number; offset?: number } = {}) {
  await requireMembership(userId, chatId);
  const limit = Math.min(opts.limit || 50, 200);
  const members = await db.chatMember.findMany({
    where: { chatId, leftAt: null },
    include: { user: { include: { privacy: true } } },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    skip: opts.offset || 0,
    take: limit + 1,
  });
  const hasMore = members.length > limit;
  return {
    items: members.slice(0, limit).map((m) => ({
      user: projectUser(m.user, m.user.privacy, userId, false),
      role: m.role,
      customTitle: m.customTitle,
      joinedAt: m.joinedAt,
      restrictedUntil: m.bannedUntil,
    })),
    hasMore,
  };
}

export async function leaveChat(userId: string, chatId: string) {
  const m = await requireMembership(userId, chatId);
  if (m.chat.type === "private" || m.chat.type === "saved") {
    // "delete chat" for private: hide + clear history semantics → archive+clear local
    await db.chatMember.update({ where: { id: m.id }, data: { archived: true } });
    return { left: true };
  }
  if (m.chat.ownerId === userId) {
    // owner must delete or transfer; simple rule: owner leaving deletes the chat
    await db.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
    await appendAndEmit([{ type: Events.CHAT_UPDATED, chatId, actorId: userId, payload: { chatId, deleted: true } }]);
    await appendAudit({ actorType: "user", actorId: userId, action: "chat.deleted_by_owner_leave", targetType: "chat", targetId: chatId });
    return { left: true, deleted: true };
  }
  await db.chatMember.update({ where: { id: m.id }, data: { leftAt: new Date() } });
  await db.chat.update({ where: { id: chatId }, data: { memberCount: { decrement: 1 } } });
  await appendAndEmit([{ type: Events.MEMBER_REMOVED, chatId, actorId: userId, payload: { chatId, userId } }]);
  return { left: true };
}

// ---------- personal chat state ----------

export async function setChatFlags(userId: string, chatId: string, patch: {
  pinned?: boolean;
  archived?: boolean;
  mutedUntil?: Date | null;
}) {
  const m = await requireMembership(userId, chatId);
  const data: Record<string, unknown> = {};
  if (patch.pinned !== undefined) data.pinned = patch.pinned;
  if (patch.archived !== undefined) data.archived = patch.archived;
  if (patch.mutedUntil !== undefined) data.mutedUntil = patch.mutedUntil;
  await db.chatMember.update({ where: { id: m.id }, data });
  if (patch.pinned !== undefined) {
    await appendAndEmit([{ type: Events.CHAT_PINNED, targetUserId: userId, chatId, actorId: userId, payload: { chatId, pinned: patch.pinned } }]);
  }
  return { ok: true };
}

export async function markRead(userId: string, chatId: string, upToSeq: number) {
  const m = await requireMembership(userId, chatId);
  const clamped = Math.min(Math.max(0, Math.floor(upToSeq)), m.chat.lastMessageSeq);
  if (clamped <= m.lastReadSeq) return { unreadCount: m.unreadCount, mentionCount: m.mentionCount };

  // count messages between old and new cursor that were unread
  const unreadBatch = await db.message.count({
    where: { chatId, seq: { gt: m.lastReadSeq, lte: clamped }, status: "sent", senderId: { not: userId } },
  });
  await db.chatMember.update({
    where: { id: m.id },
    data: {
      lastReadSeq: clamped,
      lastDeliveredSeq: Math.max(m.lastDeliveredSeq, clamped),
      unreadCount: Math.max(0, m.unreadCount - unreadBatch),
      mentionCount: 0, // opening the chat clears mentions
    },
  });
  await appendAndEmit([
    { type: Events.MESSAGE_READ, chatId, actorId: userId, payload: { chatId, userId, upToSeq: clamped } },
  ]);
  const fresh = await db.chatMember.findUnique({ where: { id: m.id } });
  return { unreadCount: fresh!.unreadCount, mentionCount: fresh!.mentionCount };
}

export async function setDraft(userId: string, chatId: string, text: string, replyToId?: string | null) {
  await requireMembership(userId, chatId);
  if (text.length > Limits.MAX_MESSAGE_LEN) throw ApiError.badRequest("Draft too long");
  await db.draft.upsert({
    where: { chatId_userId: { chatId, userId } },
    update: { text, replyToId: replyToId ?? null },
    create: { id: ulid(), chatId, userId, text, replyToId: replyToId ?? null },
  });
  return { ok: true };
}

// ---------- folders (spec §67) ----------

export async function listFolders(userId: string) {
  return db.folder.findMany({ where: { userId }, orderBy: { orderIdx: "asc" }, include: { entries: true } });
}

export async function createFolder(userId: string, name: string, icon?: string) {
  if (!name.trim() || name.length > 32) throw ApiError.badRequest("Folder name 1-32 chars");
  const count = await db.folder.count({ where: { userId } });
  if (count >= 20) throw ApiError.badRequest("Folder limit reached");
  return db.folder.create({ data: { id: ulid(), userId, name: name.trim(), icon, orderIdx: count } });
}

export async function updateFolder(userId: string, folderId: string, patch: { name?: string; icon?: string; chatIds?: string[] }) {
  const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw ApiError.notFound("Folder not found");
  const data: Record<string, unknown> = {};
  if (patch.name) data.name = patch.name.trim().slice(0, 32);
  if (patch.icon !== undefined) data.icon = patch.icon;
  await db.folder.update({ where: { id: folderId }, data });
  if (patch.chatIds) {
    await db.folderChat.deleteMany({ where: { folderId } });
    for (const chatId of patch.chatIds.slice(0, 500)) {
      await db.folderChat.create({ data: { id: ulid(), folderId, chatId } });
    }
  }
  return { ok: true };
}

export async function deleteFolder(userId: string, folderId: string) {
  const folder = await db.folder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw ApiError.notFound("Folder not found");
  await db.folder.delete({ where: { id: folderId } });
  return { ok: true };
}

// ---------- invites (spec §75-78: links, share links, QR) ----------

export async function createInvite(userId: string, chatId: string, opts: { expiresInDays?: number; usageLimit?: number } = {}) {
  const me = await requireMembership(userId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canInviteMembers");
  const code = randomToken(10);
  const invite = await db.invite.create({
    data: {
      id: ulid(),
      chatId,
      code,
      createdBy: userId,
      expiresAt: opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86400_000) : null,
      usageLimit: opts.usageLimit || null,
    },
  });
  return invite;
}

export async function listInvites(userId: string, chatId: string) {
  const me = await requireMembership(userId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canInviteMembers");
  return db.invite.findMany({ where: { chatId, isRevoked: false }, orderBy: { createdAt: "desc" } });
}

export async function revokeInvite(userId: string, inviteId: string) {
  const invite = await db.invite.findUnique({ where: { id: inviteId } });
  if (!invite) throw ApiError.notFound("Invite not found");
  const me = await requireMembership(userId, invite.chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canInviteMembers");
  await db.invite.update({ where: { id: inviteId }, data: { isRevoked: true } });
  return { ok: true };
}

export async function getInviteInfo(code: string) {
  const invite = await db.invite.findUnique({ where: { code }, include: { chat: true } });
  if (!invite || invite.isRevoked || invite.chat.deletedAt) throw ApiError.notFound("Invite invalid");
  if (invite.expiresAt && invite.expiresAt < new Date()) throw ApiError.notFound("Invite expired");
  if (invite.usageLimit && invite.useCount >= invite.usageLimit) throw ApiError.notFound("Invite exhausted");
  return {
    chatId: invite.chatId,
    chatType: invite.chat.type,
    title: invite.chat.title,
    about: invite.chat.about,
    avatarMediaId: invite.chat.avatarMediaId,
    memberCount: invite.chat.memberCount,
  };
}

export async function joinByInvite(userId: string, code: string) {
  const invite = await db.invite.findUnique({ where: { code }, include: { chat: true } });
  if (!invite || invite.isRevoked || invite.chat.deletedAt) throw ApiError.notFound("Invite invalid");
  if (invite.expiresAt && invite.expiresAt < new Date()) throw ApiError.notFound("Invite expired");
  if (invite.usageLimit && invite.useCount >= invite.usageLimit) throw ApiError.notFound("Invite exhausted");

  const existing = await db.chatMember.findUnique({ where: { chatId_userId: { chatId: invite.chatId, userId } } });
  if (existing && !existing.leftAt) return getChatCard(userId, invite.chatId);

  const chat = invite.chat;
  const defaultPerms = (chat.defaultPerms ? JSON.parse(chat.defaultPerms) : {}) as Record<string, unknown>;
  const needsApproval = !!defaultPerms.requireApproval && chat.type === "group";

  if (needsApproval) {
    await db.joinRequest.upsert({
      where: { chatId_userId: { chatId: chat.id, userId } },
      update: { status: "pending" },
      create: { id: ulid(), chatId: chat.id, userId },
    });
    return { status: "request_sent" as const };
  }

  if (existing) {
    await db.chatMember.update({ where: { id: existing.id }, data: { leftAt: null } });
  } else {
    await db.chatMember.create({ data: { id: ulid(), chatId: chat.id, userId, invitedBy: invite.createdBy } });
    await db.chat.update({ where: { id: chat.id }, data: { memberCount: { increment: 1 } } });
  }
  await db.invite.update({ where: { id: invite.id }, data: { useCount: { increment: 1 } } });
  await appendAndEmit([{ type: Events.MEMBER_ADDED, chatId: chat.id, actorId: userId, payload: { chatId: chat.id, userId } }]);
  return getChatCard(userId, chat.id);
}

// ---------- join requests ----------

export async function listJoinRequests(userId: string, chatId: string) {
  const me = await requireMembership(userId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canBanMembers");
  const reqs = await db.joinRequest.findMany({
    where: { chatId, status: "pending" },
    include: { user: { include: { privacy: true } } },
  });
  return reqs.map((r) => ({ id: r.id, user: projectUser(r.user, r.user.privacy, userId, false), createdAt: r.createdAt }));
}

export async function handleJoinRequest(userId: string, requestId: string, approve: boolean) {
  const req = await db.joinRequest.findUnique({ where: { id: requestId } });
  if (!req) throw ApiError.notFound("Request not found");
  const me = await requireMembership(userId, req.chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canBanMembers");
  if (req.status !== "pending") throw ApiError.conflict("ALREADY_HANDLED", "Request already handled");

  await db.joinRequest.update({ where: { id: requestId }, data: { status: approve ? "approved" : "declined" } });
  if (approve) {
    const existing = await db.chatMember.findUnique({ where: { chatId_userId: { chatId: req.chatId, userId: req.userId } } });
    if (existing) {
      await db.chatMember.update({ where: { id: existing.id }, data: { leftAt: null } });
    } else {
      await db.chatMember.create({ data: { id: ulid(), chatId: req.chatId, userId: req.userId } });
      await db.chat.update({ where: { id: req.chatId }, data: { memberCount: { increment: 1 } } });
    }
    await appendAndEmit([{ type: Events.MEMBER_ADDED, chatId: req.chatId, actorId: userId, payload: { chatId: req.chatId, userId: req.userId } }]);
  }
  return { ok: true };
}

// ---------- public chat discovery ----------

export async function searchPublicChats(q: string, limit = 20) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];
  return db.chat.findMany({
    where: {
      isPublic: true,
      deletedAt: null,
      OR: [{ username: { contains: term } }, { title: { contains: term } }],
    },
    select: { id: true, type: true, title: true, username: true, about: true, avatarMediaId: true, memberCount: true },
    take: limit,
  });
}

export async function joinPublicChat(userId: string, username: string) {
  const chat = await db.chat.findUnique({ where: { username: username.toLowerCase() } });
  if (!chat || chat.deletedAt || !chat.isPublic) throw ApiError.notFound("Chat not found");
  if (chat.type === "private") throw ApiError.badRequest("Not a public chat");

  const existing = await db.chatMember.findUnique({ where: { chatId_userId: { chatId: chat.id, userId } } });
  if (existing && !existing.leftAt) return getChatCard(userId, chat.id);

  const defaultPerms = (chat.defaultPerms ? JSON.parse(chat.defaultPerms) : {}) as Record<string, unknown>;
  if (defaultPerms.requireApproval) {
    await db.joinRequest.upsert({
      where: { chatId_userId: { chatId: chat.id, userId } },
      update: { status: "pending" },
      create: { id: ulid(), chatId: chat.id, userId },
    });
    return { status: "request_sent" as const };
  }
  if (existing) {
    await db.chatMember.update({ where: { id: existing.id }, data: { leftAt: null } });
  } else {
    await db.chatMember.create({ data: { id: ulid(), chatId: chat.id, userId } });
    await db.chat.update({ where: { id: chat.id }, data: { memberCount: { increment: 1 } } });
  }
  await appendAndEmit([{ type: Events.MEMBER_ADDED, chatId: chat.id, actorId: userId, payload: { chatId: chat.id, userId } }]);
  return getChatCard(userId, chat.id);
}

export async function updateChatInfo(userId: string, chatId: string, patch: {
  title?: string;
  about?: string;
  avatarMediaId?: string | null;
  username?: string | null;
  isPublic?: boolean;
  slowModeSeconds?: number;
  defaultPerms?: Partial<PermissionSet>;
}) {
  const me = await requireMembership(userId, chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canChangeInfo");

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t || t.length > Limits.MAX_CHAT_NAME) throw ApiError.badRequest("Invalid title");
    data.title = t;
  }
  if (patch.about !== undefined) data.about = patch.about?.slice(0, Limits.MAX_ABOUT) || null;
  if (patch.avatarMediaId !== undefined) {
    if (patch.avatarMediaId) {
      const media = await db.mediaObject.findUnique({ where: { id: patch.avatarMediaId } });
      if (!media || media.ownerId !== userId) throw ApiError.badRequest("Invalid avatar");
    }
    data.avatarMediaId = patch.avatarMediaId;
  }
  if (patch.username !== undefined) {
    await assertUsernameAvailable(patch.username || undefined);
    data.username = patch.username?.toLowerCase() || null;
    if (!patch.username) data.isPublic = false;
  }
  if (patch.isPublic !== undefined) data.isPublic = patch.isPublic;
  if (patch.slowModeSeconds !== undefined) {
    data.slowModeSeconds = Math.max(0, Math.min(3600, Math.floor(patch.slowModeSeconds)));
  }
  if (patch.defaultPerms !== undefined) {
    if (me.role !== "owner") throw ApiError.forbidden("Only the owner can change default permissions");
    const current = me.chat.defaultPerms ? JSON.parse(me.chat.defaultPerms) : {};
    data.defaultPerms = JSON.stringify({ ...current, ...patch.defaultPerms });
  }

  await db.chat.update({ where: { id: chatId }, data });
  await appendAndEmit([{ type: Events.CHAT_UPDATED, chatId, actorId: userId, payload: { chatId } }]);
  return getChatCard(userId, chatId);
}

export function randomToken(len: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
