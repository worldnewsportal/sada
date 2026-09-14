// ============================================================
// Messages service — idempotent send, edit, delete, forward, reply,
// reactions, pin, read/delivery receipts, cursor pagination, search,
// scheduled messages (spec §7, §13, §66-73).
// Ordering: transactional global seq. Delivery: events + realtime.
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { ulid } from "@/lib/ulid";
import { Limits } from "@/lib/shared/constants";
import { Events } from "@/lib/shared/constants";
import { appendAndEmit, extractMentions, extractUrls } from "../events";
import { requireMembership, resolvePerms, requirePerm, nextSeq } from "./chats.service";
import { isBlockedEitherWay, projectUser } from "./users.service";
import { enqueueJob } from "./queue.service";
import { log } from "../logger";

interface AttachmentInput {
  mediaId: string;
  kind?: string;
  meta?: Record<string, unknown>;
  filename?: string;
}

export interface SendMessageInput {
  text?: string;
  clientMsgId?: string;
  replyToId?: string;
  attachments?: AttachmentInput[];
  forwardOf?: { chatId: string; messageId: string };
  scheduledAt?: string;
}

function buildEntities(text: string | null) {
  if (!text) return null;
  const entities: Array<{ type: string; offset: number; length: number }> = [];
  const mentionRe = /@([a-zA-Z0-9_]{4,32})/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(text)) !== null) {
    entities.push({ type: "mention", offset: m.index, length: m[0].length });
  }
  const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
  while ((m = urlRe.exec(text)) !== null) {
    entities.push({ type: "url", offset: m.index, length: m[0].length });
  }
  return entities.length ? entities : null;
}

function previewOf(msg: { kind: string; text: string | null; editedAt: Date | null }, senderName?: string) {
  if (msg.kind === "media") {
    return { kind: "media", text: msg.text || "Attachment", senderName };
  }
  return { kind: msg.kind, text: msg.text || "", senderName, editedAt: msg.editedAt?.toISOString() };
}

// ---------- read ----------

export interface MessageDTO {
  id: string;
  seq: number;
  chatId: string;
  sender: { id: string; displayName: string; username: string | null; avatarMediaId: string | null; avatarColor: number } | null;
  kind: string;
  text: string | null;
  status: string;
  scheduledAt: string | null;
  editedAt: string | null;
  createdAt: string;
  replyTo: { id: string; text: string; senderName: string; kind: string } | null;
  forwardFromChatId: string | null;
  forwardFromMsgId?: string | null;
  forwardOriginName: string | null;
  entities: unknown;
  meta: unknown;
  attachments: Array<{ id: string; mediaId: string | null; kind: string; filename: string | null; size: number | null; mime: string | null; meta: unknown }>;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  isPinned: boolean;
  linkPreview?: unknown;
  readByCount?: number;
  seenByMe: boolean;
}
function summarizeReactions(rows: { emoji: string; userId: string }[], meId: string) {
  const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const r of rows) {
    const cur = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    cur.count++;
    if (r.userId === meId) cur.mine = true;
    map.set(r.emoji, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export async function listMessages(userId: string, chatId: string, opts: { before?: number; after?: number; limit?: number }) {
  const m = await requireMembership(userId, chatId);
  const limit = Math.min(Math.max(opts.limit || 50, 1), Limits.MAX_MESSAGE_PAGE);
  const where: Record<string, unknown> = {
    chatId,
    OR: [{ status: "sent" }, { status: "deleted" }, { AND: [{ status: "scheduled" }, { senderId: userId }] }],
  };
  if (opts.before) where.seq = { lt: opts.before };
  if (opts.after) where.seq = { gt: opts.after };

  const rows = await db.message.findMany({
    where,
    orderBy: { seq: "desc" },
    take: limit,
    include: {
      sender: { select: { id: true, displayName: true, username: true, avatarMediaId: true, avatarColor: true } },
      reactions: { select: { emoji: true, userId: true } },
      attachments: true,
      pinnedIn: { select: { id: true } },
    },
  });
  // reply previews
  const replyIds = rows.map((r) => r.replyToId).filter((x): x is string => !!x);
  const replyRows = replyIds.length
    ? await db.message.findMany({
        where: { id: { in: replyIds } },
        include: { sender: { select: { displayName: true } } },
      })
    : [];
  const replyMap = new Map(replyRows.map((r) => [r.id, r]));

  // read receipts for own messages (members whose lastReadSeq >= msg.seq)
  const memberReads = await db.chatMember.findMany({
    where: { chatId, leftAt: null },
    select: { lastReadSeq: true },
  });

  const items: MessageDTO[] = rows.map((r) => {
    const reply = r.replyToId ? replyMap.get(r.replyToId) : null;
    return {
      id: r.id,
      seq: r.seq,
      chatId: r.chatId,
      sender: r.sender,
      kind: r.kind,
      text: r.status === "deleted" ? null : r.text,
      status: r.status,
      scheduledAt: r.scheduledAt?.toISOString() || null,
      editedAt: r.editedAt?.toISOString() || null,
      createdAt: r.createdAt.toISOString(),
      replyTo: reply
        ? { id: reply.id, text: reply.text || "", senderName: reply.sender?.displayName || "", kind: reply.kind }
        : null,
      forwardFromChatId: r.forwardFromChatId,
      forwardOriginName: r.forwardOriginName,
      entities: r.entities ? JSON.parse(r.entities) : null,
      meta: r.meta ? JSON.parse(r.meta) : null,
      attachments: r.attachments.map((a) => ({
        id: a.id,
        mediaId: a.mediaId,
        kind: a.kind,
        filename: a.filename,
        size: a.size,
        mime: a.mime,
        meta: a.meta ? JSON.parse(a.meta) : null,
      })),
      reactions: summarizeReactions(r.reactions, userId),
      isPinned: r.pinnedIn.length > 0,
      readByCount: memberReads.filter((mr) => mr.lastReadSeq >= r.seq).length,
      seenByMe: m.lastReadSeq >= r.seq,
    };
  });
  return { items: items.reverse(), hasMore: rows.length === limit, nextCursor: rows.length ? rows[rows.length - 1].seq : null };
}

// ---------- send (idempotent) ----------

export async function sendMessage(userId: string, chatId: string, input: SendMessageInput) {
  const m = await requireMembership(userId, chatId);
  const chat = m.chat;

  // Idempotency (spec §7): clientMsgId unique per (chat, sender)
  if (input.clientMsgId) {
    const existing = await db.message.findUnique({
      where: { chatId_senderId_clientMsgId: { chatId, senderId: userId, clientMsgId: input.clientMsgId } },
      include: { attachments: true },
    });
    if (existing) {
      return { message: (await listMessages(userId, chatId, { after: existing.seq - 1, limit: 1 })).items[0], duplicate: true };
    }
  }

  const perms = resolvePerms(m.role, m.permsOverride, chat.defaultPerms);
  if (chat.type === "channel" && !perms.canPostMessages) throw ApiError.forbidden("Only admins can post in channels");
  if (m.role === "restricted") throw ApiError.forbidden("You are restricted in this chat");

  const text = input.text?.trim() || null;
  if (text && text.length > Limits.MAX_MESSAGE_LEN) throw ApiError.badRequest(`Message exceeds ${Limits.MAX_MESSAGE_LEN} characters`);
  const attachments = input.attachments || [];
  if (attachments.length > Limits.MAX_ATTACHMENTS) throw ApiError.badRequest(`Max ${Limits.MAX_ATTACHMENTS} attachments`);
  if (!text && attachments.length === 0) throw ApiError.badRequest("Empty message");

  // private chats: block check
  if (chat.type === "private") {
    const peer = await db.chatMember.findFirst({ where: { chatId, userId: { not: userId }, leftAt: null } });
    if (peer && (await isBlockedEitherWay(userId, peer.userId))) {
      throw ApiError.forbidden("You cannot message this user");
    }
  }

  // slow mode (spec §20)
  if (chat.slowModeSeconds > 0 && m.role !== "owner" && m.role !== "admin") {
    const last = await db.message.findFirst({ where: { chatId, senderId: userId, status: "sent" }, orderBy: { seq: "desc" } });
    if (last && Date.now() - last.createdAt.getTime() < chat.slowModeSeconds * 1000) {
      const waitS = Math.ceil((chat.slowModeSeconds * 1000 - (Date.now() - last.createdAt.getTime())) / 1000);
      throw new ApiError(429, "SLOW_MODE", `Slow mode: wait ${waitS}s`, { retryAfterS: waitS });
    }
  }

  // attachments must reference ready media owned by sender
  for (const a of attachments) {
    const media = await db.mediaObject.findUnique({ where: { id: a.mediaId } });
    if (!media || media.ownerId !== userId) throw ApiError.badRequest(`Invalid media: ${a.mediaId}`);
    if (media.status !== "ready") throw ApiError.conflict("MEDIA_NOT_READY", `Media ${a.mediaId} is still processing`);
  }

  // reply target
  let replyToId: string | null = null;
  if (input.replyToId) {
    const target = await db.message.findUnique({ where: { id: input.replyToId } });
    if (!target || target.chatId !== chatId) throw ApiError.badRequest("Invalid reply target");
    replyToId = target.id;
  }

  // scheduled?
  let scheduledAt: Date | null = null;
  if (input.scheduledAt) {
    const t = new Date(input.scheduledAt);
    if (isNaN(t.getTime()) || t.getTime() < Date.now() + 10_000) {
      throw ApiError.badRequest("scheduledAt must be a future time (min 10s ahead)");
    }
    if (t.getTime() > Date.now() + 365 * 86400_000) throw ApiError.badRequest("scheduledAt too far in the future");
    scheduledAt = t;
  }

  // forward metadata
  let forwardMeta: { chatId: string | null; msgId: string | null; originName: string | null } = { chatId: null, msgId: null, originName: null };
  if (input.forwardOf) {
    const src = await db.message.findUnique({ where: { id: input.forwardOf.messageId }, include: { chat: true } });
    if (!src || src.status === "deleted") throw ApiError.notFound("Forward source not found");
    await requireMembership(userId, input.forwardOf.chatId);
    forwardMeta = { chatId: src.chatId, msgId: src.id, originName: src.chat.title || "Private chat" };
  }

  const msgId = ulid();
  const seq = await nextSeq();
  const mentions = extractMentions(text);
  const mentionedUsers = mentions.length
    ? await db.user.findMany({ where: { username: { in: mentions } }, select: { id: true, username: true } })
    : [];
  const sender = await db.user.findUnique({ where: { id: userId } });
  const isChannelPost = chat.type === "channel";

  const created = await db.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: {
        id: msgId,
        seq,
        chatId,
        senderId: userId,
        kind: attachments.length ? "media" : "text",
        text,
        status: scheduledAt ? "scheduled" : "sent",
        scheduledAt,
        replyToId,
        forwardFromChatId: forwardMeta.chatId,
        forwardFromMsgId: forwardMeta.msgId,
        forwardOriginName: forwardMeta.originName,
        entities: buildEntities(text) ? JSON.stringify(buildEntities(text)) : null,
        clientMsgId: input.clientMsgId || null,
      },
    });
    for (const [i, a] of attachments.entries()) {
      await tx.attachment.create({
        data: {
          id: ulid(),
          messageId: msg.id,
          mediaId: a.mediaId,
          kind: a.kind || "document",
          orderIdx: i,
          filename: a.filename || null,
          meta: a.meta ? JSON.stringify(a.meta) : null,
        },
      });
    }
    if (!scheduledAt) {
      // unread bump for everyone except sender (muted members still count unread)
      await tx.chatMember.updateMany({
        where: { chatId, userId: { not: userId }, leftAt: null },
        data: { unreadCount: { increment: 1 }, lastDeliveredSeq: seq },
      });
      // mentions (spec §73)
      const mentionIds = new Set(mentionedUsers.map((u) => u.id));
      if (mentionIds.size) {
        await tx.chatMember.updateMany({
          where: { chatId, userId: { in: [...mentionIds] } },
          data: { mentionCount: { increment: 1 } },
        });
      }
      await tx.chat.update({
        where: { id: chatId },
        data: {
          lastMessageAt: msg.createdAt,
          lastMessageSeq: seq,
          lastMsgPreview: JSON.stringify(
            previewOf({ kind: msg.kind, text: msg.text, editedAt: null }, chat.type === "private" ? undefined : sender?.displayName)
          ),
        },
      });
      // sender auto-reads own message
      await tx.chatMember.update({
        where: { id: m.id },
        data: { lastReadSeq: seq, lastDeliveredSeq: seq },
      });
    }
    return msg;
  });

  if (scheduledAt) {
    await enqueueJob("scheduled.send", { messageId: created.id, chatId }, { runAt: scheduledAt, dedupeKey: `sched-${created.id}` });
    return { message: (await listMessages(userId, chatId, { after: seq - 1, limit: 1 })).items[0], scheduled: true };
  }

  // events + realtime
  await appendAndEmit([
    {
      type: isChannelPost ? Events.CHANNEL_POSTED : Events.MESSAGE_CREATED,
      chatId,
      actorId: userId,
      payload: { messageId: created.id, seq, senderId: userId, kind: created.kind, chatType: chat.type },
    },
  ]);

  // link preview job (spec §38)
  const urls = extractUrls(text);
  if (urls.length) {
    await enqueueJob("link.preview", { messageId: created.id, url: urls[0] }, { dedupeKey: `lp-${created.id}` });
  }
  // push notifications (worker decides recipients & respects mutes/privacy)
  await enqueueJob("push.send", { messageId: created.id, chatId, senderId: userId }, { dedupeKey: `push-${created.id}` });

  const dto = (await listMessages(userId, chatId, { after: seq - 1, limit: 1 })).items[0];
  return { message: dto, scheduled: false };
}

// ---------- edit / delete ----------

export async function editMessage(userId: string, messageId: string, text: string) {
  enforceEditRate(userId);
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { chat: true } });
  if (!msg || msg.status === "deleted") throw ApiError.notFound("Message not found");
  const me = await requireMembership(userId, msg.chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);

  const isAuthor = msg.senderId === userId;
  const canEditAsAdmin = msg.chat.type === "channel" && perms.canEditMessages;
  if (!isAuthor && !canEditAsAdmin) throw ApiError.forbidden("Cannot edit this message");
  if (msg.createdAt.getTime() < Date.now() - 48 * 3600_000) throw ApiError.forbidden("Edit window expired (48h)");

  const newText = text.trim();
  if (newText.length > Limits.MAX_MESSAGE_LEN) throw ApiError.badRequest("Message too long");

  const updated = await db.message.update({
    where: { id: messageId },
    data: { text: newText, editedAt: new Date(), entities: buildEntities(newText) ? JSON.stringify(buildEntities(newText)) : null },
  });
  await db.chat.update({
    where: { id: msg.chatId },
    data: { lastMsgPreview: JSON.stringify(previewOf({ kind: updated.kind, text: updated.text, editedAt: updated.editedAt })) },
  });
  await appendAndEmit([
    { type: Events.MESSAGE_UPDATED, chatId: msg.chatId, actorId: userId, payload: { messageId, text: newText, editedAt: updated.editedAt?.toISOString() } },
  ]);
  return { ok: true };
}

import { enforceRateLimit } from "../security/rate-limit";
function enforceEditRate(userId: string) {
  enforceRateLimit("messages:edit", userId);
}

export async function deleteMessage(userId: string, messageId: string) {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { chat: true } });
  if (!msg || msg.status === "deleted") throw ApiError.notFound("Message not found");
  const me = await requireMembership(userId, msg.chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);

  const isAuthor = msg.senderId === userId;
  const isModerator = perms.canDeleteMessages;
  if (!isAuthor && !isModerator) throw ApiError.forbidden("Cannot delete this message");

  await db.message.update({
    where: { id: messageId },
    data: { status: "deleted", deletedAt: new Date(), deletedBy: userId },
  });
  await appendAndEmit([
    { type: Events.MESSAGE_DELETED, chatId: msg.chatId, actorId: userId, payload: { messageId } },
  ]);
  return { ok: true };
}

// ---------- forward ----------

export async function forwardMessages(userId: string, messageIds: string[], targetChatIds: string[]) {
  const results: Array<{ chatId: string; messageId: string | null; ok: boolean; error?: string }> = [];
  for (const targetChatId of targetChatIds.slice(0, 5)) {
    for (const messageId of messageIds.slice(0, 50)) {
      try {
        const res = await sendMessage(userId, targetChatId, { forwardOf: { chatId: "", messageId } });
        results.push({ chatId: targetChatId, messageId: res.message?.id, ok: true });
      } catch (e) {
        log.warn("forward-failed", { err: String(e), messageId });
        results.push({ chatId: targetChatId, messageId, ok: false, error: e instanceof ApiError ? e.code : "FAILED" });
      }
    }
  }
  return results;
}

// ---------- reactions (spec §16) ----------

export async function setReaction(userId: string, messageId: string, emoji: string | null) {
  enforceRateLimit("reactions:set", userId);
  const msg = await db.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.status === "deleted") throw ApiError.notFound("Message not found");
  await requireMembership(userId, msg.chatId);

  if (emoji === null) {
    await db.messageReaction.deleteMany({ where: { messageId, userId } });
  } else {
    if (emoji.length > 16) throw ApiError.badRequest("Invalid emoji");
    const existing = await db.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    if (existing) {
      await db.messageReaction.delete({ where: { id: existing.id } });
    } else {
      await db.messageReaction.create({ data: { id: ulid(), messageId, userId, emoji } });
      // notify message author
      if (msg.senderId && msg.senderId !== userId) {
        const actor = await db.user.findUnique({ where: { id: userId } });
        await db.notification.create({
          data: {
            id: ulid(),
            userId: msg.senderId,
            type: "reaction",
            chatId: msg.chatId,
            messageId,
            title: actor?.displayName || "Someone",
            body: `reacted ${emoji} to your message`,
            dataJson: JSON.stringify({ chatId: msg.chatId, messageId }),
          },
        });
        await appendAndEmit([
          { type: Events.NOTIFICATION_CREATED, targetUserId: msg.senderId, payload: { type: "reaction", chatId: msg.chatId } },
        ]);
      }
    }
  }
  const rows = await db.messageReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } });
  await appendAndEmit([
    { type: Events.MESSAGE_REACTION_UPDATED, chatId: msg.chatId, actorId: userId, payload: { messageId, reactions: summarizeReactions(rows, userId) } },
  ]);
  return { reactions: summarizeReactions(rows, userId) };
}

// ---------- pin (spec §17, §71) ----------

export async function pinMessage(userId: string, messageId: string, pinned: boolean) {
  const msg = await db.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.status === "deleted") throw ApiError.notFound("Message not found");
  const me = await requireMembership(userId, msg.chatId);
  const perms = resolvePerms(me.role, me.permsOverride, me.chat.defaultPerms);
  requirePerm(perms, "canPinMessages");

  if (pinned) {
    await db.pinnedMessage.upsert({
      where: { chatId_messageId: { chatId: msg.chatId, messageId } },
      update: {},
      create: { id: ulid(), chatId: msg.chatId, messageId, pinnedBy: userId },
    });
  } else {
    await db.pinnedMessage.deleteMany({ where: { chatId: msg.chatId, messageId } });
  }
  const count = await db.pinnedMessage.count({ where: { chatId: msg.chatId } });
  await appendAndEmit([
    { type: Events.MESSAGE_PINNED, chatId: msg.chatId, actorId: userId, payload: { messageId, pinned, pinnedCount: count } },
  ]);
  return { pinned, pinnedCount: count };
}

export async function listPinned(userId: string, chatId: string) {
  await requireMembership(userId, chatId);
  const rows = await db.pinnedMessage.findMany({
    where: { chatId },
    include: { message: { include: { sender: { select: { id: true, displayName: true } } } } },
    orderBy: { orderIdx: "asc" },
  });
  return rows
    .filter((r) => r.message.status !== "deleted")
    .map((r) => ({ messageId: r.messageId, text: r.message.text, senderName: r.message.sender?.displayName, createdAt: r.message.createdAt }));
}

// ---------- scheduled publish (called by worker) ----------

export async function publishScheduledMessage(messageId: string) {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { chat: true } });
  if (!msg || msg.status !== "scheduled") return { skipped: true };

  const seq = await nextSeq();
  await db.$transaction(async (tx) => {
    await tx.message.update({ where: { id: messageId }, data: { status: "sent", createdAt: new Date() } });
    await tx.chatMember.updateMany({
      where: { chatId: msg.chatId, userId: { not: msg.senderId ?? "" }, leftAt: null },
      data: { unreadCount: { increment: 1 }, lastDeliveredSeq: seq },
    });
    const sender = msg.senderId ? await tx.user.findUnique({ where: { id: msg.senderId } }) : null;
    await tx.chat.update({
      where: { id: msg.chatId },
      data: {
        lastMessageAt: new Date(),
        lastMessageSeq: seq,
        lastMsgPreview: JSON.stringify(previewOf({ kind: msg.kind, text: msg.text, editedAt: null }, msg.chat.type === "private" ? undefined : sender?.displayName || "")),
      },
    });
  });
  await appendAndEmit([
    {
      type: msg.chat.type === "channel" ? Events.CHANNEL_POSTED : Events.MESSAGE_CREATED,
      chatId: msg.chatId,
      actorId: msg.senderId,
      payload: { messageId, seq, senderId: msg.senderId, kind: msg.kind, chatType: msg.chat.type },
    },
  ]);
  if (msg.senderId) {
    await db.chatMember.updateMany({
      where: { chatId: msg.chatId, userId: msg.senderId },
      data: { lastReadSeq: seq, lastDeliveredSeq: seq },
    });
  }
  await enqueueJob("push.send", { messageId, chatId: msg.chatId, senderId: msg.senderId }, { dedupeKey: `push-${messageId}` });
  return { published: true };
}

// ---------- search (spec §19: Postgres FTS in prod; LIKE now) ----------

export async function searchMessages(userId: string, q: string, chatId?: string, limit = 30) {
  const term = q.trim();
  if (term.length < 2) return [];
  const myChats = await db.chatMember.findMany({ where: { userId, leftAt: null }, select: { chatId: true } });
  const scope = chatId ? [chatId] : myChats.map((c) => c.chatId);
  if (!scope.length) return [];

  const rows = await db.message.findMany({
    where: {
      chatId: { in: scope },
      status: "sent",
      text: { contains: term },
    },
    orderBy: { seq: "desc" },
    take: Math.min(limit, 100),
    include: { chat: { select: { id: true, type: true, title: true } } },
  });
  return rows.map((r) => ({
    messageId: r.id,
    chatId: r.chatId,
    chatTitle: r.chat.title || "Private chat",
    chatType: r.chat.type,
    text: r.text,
    createdAt: r.createdAt,
    senderId: r.senderId,
  }));
}

// ---------- comments on channel posts (linked discussion) ----------

export async function listComments(userId: string, postId: string, opts: { before?: number; limit?: number } = {}) {
  const post = await db.message.findUnique({ where: { id: postId }, include: { chat: true } });
  if (!post) throw ApiError.notFound("Post not found");
  if (post.chat.discussionChatId) {
    return listMessages(userId, post.chat.discussionChatId, { ...opts, limit: opts.limit || 30 });
  }
  // no linked chat → comments live under the post (rootMessageId)
  return listMessages(userId, post.chatId, opts);
}
