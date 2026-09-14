// ============================================================
// Users service — profiles, usernames, privacy, blocking,
// privacy-preserving contact sync, search (spec §1, §57-62, §49).
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { Limits, PRIVACY_VISIBILITY } from "@/lib/shared/constants";
import { enforceRateLimit } from "../security/rate-limit";
import { appendAudit } from "./audit.service";
import { phoneHash } from "./auth.service";

export interface PublicUser {
  id: string;
  username: string | null;
  displayName: string;
  bio: string | null;
  avatarMediaId: string | null;
  avatarColor: number;
  isVerified: boolean;
  isBot: boolean;
  lastSeenAt: Date | null;
  lastSeenVisible: boolean;
  phoneVisible: boolean;
}

/** Apply privacy rules (spec §57-61): viewer-sensitive projection. */
export function projectUser(target: {
  id: string;
  username: string | null;
  displayName: string;
  bio: string | null;
  avatarMediaId: string | null;
  avatarColor: number;
  isVerified: boolean;
  isBot: boolean;
  lastSeenAt: Date | null;
  phone?: string | null;
}, privacy: {
  lastSeenVisibility: string;
  phoneVisibility: string;
  photoVisibility: string;
} | null, viewerId: string, viewerIsContact: boolean): PublicUser {
  const vis = privacy || { lastSeenVisibility: "everyone", phoneVisibility: "contacts", photoVisibility: "everyone" };
  const allowed = (rule: string) =>
    rule === "everyone" || (rule === "contacts" && viewerIsContact) || (viewerId === target.id);
  return {
    id: target.id,
    username: target.username,
    displayName: target.displayName,
    bio: target.bio,
    avatarMediaId: allowed(vis.photoVisibility) ? target.avatarMediaId : null,
    avatarColor: target.avatarColor,
    isVerified: target.isVerified,
    isBot: target.isBot,
    lastSeenAt: allowed(vis.lastSeenVisibility) ? target.lastSeenAt : null,
    lastSeenVisible: allowed(vis.lastSeenVisibility),
    phoneVisible: viewerId === target.id || allowed(vis.phoneVisibility),
  };
}

export async function isContact(viewerId: string, targetId: string): Promise<boolean> {
  const c = await db.contact.findFirst({ where: { ownerId: viewerId, contactUserId: targetId } });
  return !!c;
}

export async function getPublicUser(viewerId: string, userId: string): Promise<PublicUser> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { privacy: true },
  });
  if (!user || user.deletedAt) throw ApiError.notFound("User not found");
  const contact = await isContact(viewerId, userId);
  return projectUser(user, user.privacy, viewerId, contact);
}

// ---------- profile ----------

const USERNAME_RE = /^[a-zA-Z0-9_]{4,32}$/;
const RESERVED = new Set(["admin", "support", "moderation", "sada", "api", "system", "root", "official", "staff", "null", "undefined"]);

export async function updateProfile(userId: string, input: {
  displayName?: string;
  bio?: string;
  username?: string | null;
  avatarMediaId?: string | null;
}) {
  const data: Record<string, unknown> = {};

  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 1 || name.length > 64) throw ApiError.badRequest("Name must be 1-64 characters");
    data.displayName = name;
  }
  if (input.bio !== undefined) {
    if (input.bio.length > Limits.MAX_BIO) throw ApiError.badRequest(`Bio exceeds ${Limits.MAX_BIO} characters`);
    data.bio = input.bio || null;
  }
  if (input.username !== undefined) {
    if (input.username === null) {
      data.username = null;
    } else {
      const uname = input.username.toLowerCase();
      enforceRateLimit("users:set-username", userId);
      if (!USERNAME_RE.test(uname)) {
        throw ApiError.badRequest(`Username must be ${Limits.USERNAME_MIN}-${Limits.USERNAME_MAX} chars: letters, digits, underscore`);
      }
      if (RESERVED.has(uname)) throw ApiError.conflict("USERNAME_TAKEN", "This username is reserved");
      const existing = await db.user.findUnique({ where: { username: uname } });
      if (existing && existing.id !== userId) throw ApiError.conflict("USERNAME_TAKEN", "Username already taken");
      data.username = uname;
    }
  }
  if (input.avatarMediaId !== undefined) {
    if (input.avatarMediaId === null) {
      data.avatarMediaId = null;
    } else {
      const media = await db.mediaObject.findUnique({ where: { id: input.avatarMediaId } });
      if (!media || media.ownerId !== userId || media.kind !== "avatar") {
        throw ApiError.badRequest("Invalid avatar media");
      }
      data.avatarMediaId = input.avatarMediaId;
    }
  }
  const user = await db.user.update({ where: { id: userId }, data });
  return { id: user.id, displayName: user.displayName, username: user.username, bio: user.bio, avatarMediaId: user.avatarMediaId };
}

// ---------- privacy ----------

export async function getPrivacy(userId: string) {
  let p = await db.userPrivacy.findUnique({ where: { userId } });
  if (!p) p = await db.userPrivacy.create({ data: { userId } });
  return p;
}

export async function setPrivacy(userId: string, patch: Partial<Record<string, string | boolean>>) {
  const data: Record<string, unknown> = {};
  for (const key of ["lastSeenVisibility", "phoneVisibility", "photoVisibility", "whoCanInviteMe", "whoCanMessageMe"]) {
    const v = patch[key];
    if (v !== undefined) {
      if (!PRIVACY_VISIBILITY.includes(v as "everyone")) throw ApiError.badRequest(`Invalid value for ${key}`);
      data[key] = v;
    }
  }
  if (patch.readReceipts !== undefined) data.readReceipts = !!patch.readReceipts;
  await db.userPrivacy.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return getPrivacy(userId);
}

// ---------- blocking (spec §48, §22) ----------

export async function blockUser(userId: string, targetId: string) {
  if (userId === targetId) throw ApiError.badRequest("Cannot block yourself");
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (!target || target.deletedAt) throw ApiError.notFound("User not found");
  await db.blockedUser.upsert({
    where: { userId_blockedId: { userId, blockedId: targetId } },
    update: {},
    create: { id: crypto.randomUUID(), userId, blockedId: targetId },
  });
  await appendAudit({ actorType: "user", actorId: userId, action: "user.blocked", targetType: "user", targetId });
  return { blocked: true };
}

export async function unblockUser(userId: string, targetId: string) {
  await db.blockedUser.deleteMany({ where: { userId, blockedId: targetId } });
  return { blocked: false };
}

export async function listBlocked(userId: string) {
  const rows = await db.blockedUser.findMany({
    where: { userId },
    include: { blocked: { include: { privacy: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => projectUser(r.blocked, r.blocked.privacy, userId, false));
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const count = await db.blockedUser.count({
    where: { OR: [{ userId: a, blockedId: b }, { userId: b, blockedId: a }] },
  });
  return count > 0;
}

// ---------- contact sync (privacy-preserving, spec §50) ----------

export async function syncContacts(userId: string, contacts: { phoneHashes: string[]; names?: Record<string, string> }) {
  const hashes = [...new Set(contacts.phoneHashes)]
    .filter((h) => /^[a-f0-9]{64}$/.test(h))
    .slice(0, 5000);
  if (hashes.length === 0) throw ApiError.badRequest("phoneHashes required (sha256 hex)");

  const matched = await db.user.findMany({
    where: { phoneHash: { in: hashes }, deletedAt: null },
    include: { privacy: true },
  });
  const byHash = new Map(matched.map((u) => [u.phoneHash, u]));

  for (const h of hashes) {
    const user = byHash.get(h);
    await db.contact.upsert({
      where: { ownerId_phoneHash: { ownerId: userId, phoneHash: h } },
      update: { contactUserId: user?.id ?? null },
      create: {
        id: crypto.randomUUID(),
        ownerId: userId,
        phoneHash: h,
        contactUserId: user?.id ?? null,
        displayName: contacts.names?.[h]?.slice(0, 64) || "Contact",
      },
    });
  }
  await db.user.update({ where: { id: userId }, data: { contactsSyncedAt: new Date() } });

  return {
    registered: matched.map((u) => projectUser(u, u.privacy, userId, true)),
    totalSubmitted: hashes.length,
  };
}

export async function listContacts(userId: string) {
  const contacts = await db.contact.findMany({
    where: { ownerId: userId, contactUserId: { not: null } },
    include: { contactUser: { include: { privacy: true } } },
    orderBy: { createdAt: "desc" },
  });
  return contacts
    .filter((c) => c.contactUser && !c.contactUser.deletedAt)
    .map((c) => ({
      localName: c.displayName,
      user: projectUser(c.contactUser!, c.contactUser!.privacy, userId, true),
    }));
}

// ---------- search (spec §19) ----------

export async function searchUsers(viewerId: string, q: string, limit = 20) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];
  enforceRateLimit("search:global", viewerId);
  const rows = await db.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { username: { contains: term } },
        { displayName: { contains: term } },
        ...(term.length >= 7 ? [{ phoneHash: phoneHashLike(term) }] : []),
      ],
    },
    include: { privacy: true },
    take: limit,
  });
  const contactSet = new Set(
    (await db.contact.findMany({ where: { ownerId: viewerId }, select: { contactUserId: true } })).map((c) => c.contactUserId)
  );
  return rows.map((u) => ({ ...projectUser(u, u.privacy, viewerId, contactSet.has(u.id)), phone: undefined }));
}

function phoneHashLike(rawPhone: string): string {
  const clean = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
  return phoneHash(clean);
}

// ---------- settings ----------

/** Whether the account has a sign-in password (for settings UI). */
export async function hasPassword(userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return { hasPassword: !!u?.passwordHash };
}

export async function getSettings(userId: string) {
  let s = await db.userSettings.findUnique({ where: { userId } });
  if (!s) s = await db.userSettings.create({ data: { userId } });
  return { ...s, notifJson: undefined, notif: JSON.parse(s.notifJson || "{}"), autoDownload: JSON.parse(s.autoDownloadJson || "{}") };
}

export async function updateSettings(userId: string, patch: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (patch.theme !== undefined && ["light", "dark", "system"].includes(patch.theme as string)) data.theme = patch.theme;
  if (patch.locale !== undefined && ["ar", "en"].includes(patch.locale as string)) data.locale = patch.locale;
  if (patch.notif !== undefined) data.notifJson = JSON.stringify(patch.notif);
  if (patch.autoDownload !== undefined) data.autoDownloadJson = JSON.stringify(patch.autoDownload);
  if (patch.maxCacheMb !== undefined && typeof patch.maxCacheMb === "number") data.maxCacheMb = Math.min(patch.maxCacheMb, 65536);
  if (patch.mediaRetentionDays !== undefined && typeof patch.mediaRetentionDays === "number") {
    data.mediaRetentionDays = Math.max(0, Math.min(365, patch.mediaRetentionDays));
  }
  await db.userSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return getSettings(userId);
}

// ---------- data export (spec §49) ----------

export async function exportMyData(userId: string) {
  const [user, settings, privacy, memberships, messages, blocked, contacts] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    getSettings(userId),
    getPrivacy(userId),
    db.chatMember.findMany({ where: { userId }, include: { chat: { select: { id: true, type: true, title: true } } } }),
    db.message.findMany({ where: { senderId: userId }, select: { id: true, chatId: true, text: true, createdAt: true, status: true }, take: 10000 }),
    listBlocked(userId),
    listContacts(userId),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profile: user ? { id: user.id, phone: user.phone, username: user.username, displayName: user.displayName, bio: user.bio, createdAt: user.createdAt } : null,
    settings, privacy,
    chats: memberships.map((m) => ({ chat: m.chat, role: m.role, joinedAt: m.joinedAt })),
    messages,
    blocked: blocked.map((b) => b.id),
    contacts,
  };
}
