// Account deletion handler (spec §49, §56: account deletion, data minimization).
// Anonymizes the user tombstone, revokes sessions/subscriptions, removes
// personal content while preserving conversation integrity for others.
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/server/services/audit.service";

export async function processAccountDeletion(userId: string): Promise<Record<string, unknown>> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { alreadyDeleted: true };

  // 1. revoke sessions + push subscriptions
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "account-deleted" } });
  await db.pushSubscription.deleteMany({ where: { userId } });

  // 2. leave chats (channels subscribers too)
  await db.chatMember.deleteMany({ where: { userId } });
  await db.channelMember.deleteMany({ where: { userId } });

  // 3. delete own messages' content (keep tombstones so replies remain coherent)
  await db.message.updateMany({
    where: { senderId: userId, status: { not: "deleted" } },
    data: { status: "deleted", deletedAt: new Date(), deletedBy: userId, text: null },
  });

  // 4. wipe personal data
  await db.draft.deleteMany({ where: { userId } });
  await db.notification.deleteMany({ where: { userId } });
  await db.contact.deleteMany({ where: { ownerId: userId } });
  await db.blockedUser.deleteMany({ where: { OR: [{ userId }, { blockedId: userId }] } });
  await db.folder.deleteMany({ where: { userId } });

  // 5. anonymize the user row (tombstone keeps FK integrity for chat history)
  await db.user.update({
    where: { id: userId },
    data: {
      deletedAt: new Date(),
      displayName: "Deleted Account",
      username: null,
      bio: null,
      avatarMediaId: null,
      email: null,
      twofaSecret: null,
      twofaEnabled: false,
      phone: `deleted-${userId}`, // preserve unique constraint, drop the number
      phoneHash: `deleted-${userId}`,
    },
  });

  await appendAudit({ actorType: "system", actorId: userId, action: "account.deleted", targetType: "user", targetId: userId });
  return { deleted: true };
}
