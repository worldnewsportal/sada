// Seed: initial admin + demo users + group + channel (idempotent).
// Run: bun scripts/seed.ts
import { db } from "../src/lib/db";
import { randomBytes, createHash, randomInt } from "crypto";
import { ulid } from "../src/lib/ulid";
import { nextSeq } from "../src/lib/server/services/chats.service";

const PEPPER = process.env.APP_PEPPER || "dev-pepper";
function phoneHash(phone: string) {
  return createHash("sha256").update(`${phone}:${PEPPER}`).digest("hex");
}

async function upsertUser(phone: string, displayName: string, username: string | null) {
  const existing = await db.user.findUnique({ where: { phone } });
  if (existing) return existing;
  return db.user.create({
    data: {
      id: randomBytes(12).toString("hex"),
      phone,
      phoneHash: phoneHash(phone),
      displayName,
      username,
      avatarColor: randomInt(0, 8),
    },
  });
}

async function main() {
  const users = [
    await upsertUser("+9647700000001", "أحمد", "ahmed"),
    await upsertUser("+9647700000002", "فاطمة", "fatima"),
    await upsertUser("+9647700000003", "علي", "ali"),
    await upsertUser("+9647700000004", "زينب", "zainab"),
  ];

  // demo group with all users
  const groupTitle = "فريق صدى";
  let group = await db.chat.findFirst({ where: { type: "group", title: groupTitle } });
  if (!group) {
    const chatId = ulid();
    const seq = await nextSeq();
    await db.$transaction([
      db.chat.create({
        data: {
          id: chatId, type: "group", title: groupTitle,
          about: "مجموعة تجريبية لفريق صدى", memberCount: users.length,
          defaultPerms: JSON.stringify({ canDeleteMessages: true, canBanMembers: false, canInviteMembers: true, canPinMessages: true, canChangeInfo: false, canManageTopics: false, canPostMessages: true, canEditMessages: false, canAddAdmins: false, canRestrictMembers: false }),
        },
      }),
      db.chatMember.create({ data: { id: ulid(), chatId, userId: users[0].id, role: "owner" } }),
      ...users.slice(1).map((u) => db.chatMember.create({ data: { id: ulid(), chatId, userId: u.id } })),
      db.message.create({ data: { id: ulid(), seq, chatId, kind: "system", text: `Group "${groupTitle}" created` } }),
    ]);
    group = await db.chat.findUnique({ where: { id: chatId } });
    // welcome messages
    for (const [i, u] of users.entries()) {
      const s = await nextSeq();
      await db.$transaction([
        db.message.create({ data: { id: ulid(), seq: s, chatId: chatId, senderId: u.id, text: `مرحباً من ${u.displayName} 👋` } }),
        db.chat.update({ where: { id: chatId }, data: { lastMessageSeq: s, lastMessageAt: new Date(), lastMsgPreview: JSON.stringify({ kind: "text", text: `مرحباً من ${u.displayName} 👋`, senderName: u.displayName }) } }),
        db.chatMember.updateMany({ where: { chatId, userId: { not: u.id } }, data: { unreadCount: { increment: 1 } } }),
      ]);
      void i;
    }
  }

  // public channel
  const channelUsername = "sada_news";
  let channel = await db.chat.findUnique({ where: { username: channelUsername } });
  if (!channel) {
    const chatId = ulid();
    const seq = await nextSeq();
    await db.$transaction([
      db.chat.create({
        data: {
          id: chatId, type: "channel", title: "أخبار صدى", username: channelUsername,
          about: "القناة الرسمية لتحديثات منصة صدى", isPublic: true,
          ownerId: users[0].id, memberCount: users.length,
        },
      }),
      db.chatMember.create({ data: { id: ulid(), chatId, userId: users[0].id, role: "owner" } }),
      ...users.slice(1).map((u) => db.chatMember.create({ data: { id: ulid(), chatId, userId: u.id } })),
      db.message.create({ data: { id: ulid(), seq, chatId, senderId: users[0].id, text: "أهلاً بكم في قناة أخبار صدى! 🎉" } }),
    ]);
    channel = await db.chat.findUnique({ where: { id: chatId } });
  }

  // saved messages chat for first user
  const savedExists = await db.chat.findFirst({
    where: { type: "saved", members: { some: { userId: users[0].id } } },
  });
  if (!savedExists) {
    const chatId = ulid();
    await db.$transaction([
      db.chat.create({ data: { id: chatId, type: "saved", title: "Saved Messages", memberCount: 1 } }),
      db.chatMember.create({ data: { id: ulid(), chatId, userId: users[0].id, role: "owner" } }),
    ]);
  }

  console.log(JSON.stringify({
    seeded: true,
    users: users.map((u) => ({ phone: u.phone, name: u.displayName, username: u.username })),
    group: group?.id, channel: channel?.id,
    note: "OTP dev-echo is enabled: login with any of these phones; the code appears in the API response (dev mode).",
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
