// ============================================================
// Admin service (spec §37): separate & stronger authentication,
// reports queue, bans, stats, audit logs, user/chat management.
// Admin identity is fully separate from user identity.
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { signAdminToken, verifyToken } from "../jwt";
import { hashPassword, verifyPassword, validateAdminPassword } from "../security/password";
import { verifyTotp } from "../security/totp";
import { enforceRateLimit } from "../security/rate-limit";
import { appendAudit } from "./audit.service";
import { env } from "../env";
import { log } from "../logger";
import { randomBytes } from "crypto";

export async function adminLogin(username: string, password: string, totp: string | undefined, ip: string) {
  enforceRateLimit("admin:login", ip);
  const admin = await db.adminUser.findUnique({ where: { username: username.toLowerCase() } });
  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    await appendAudit({ actorType: "admin", action: "admin.login_failed", targetId: username, ip });
    throw ApiError.unauthorized("Invalid credentials");
  }
  if (admin.totpEnabled && admin.totpSecret) {
    if (!totp) throw new ApiError(401, "TOTP_REQUIRED", "2FA code required");
    if (!verifyTotp(admin.totpSecret, totp)) throw ApiError.unauthorized("Invalid 2FA code");
  }
  await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  await appendAudit({ actorType: "admin", actorId: admin.id, action: "admin.login", ip });
  const token = await signAdminToken(admin.id);
  return { token, admin: { id: admin.id, username: admin.username, role: admin.role, totpEnabled: admin.totpEnabled } };
}

export async function requireAdmin(req: Request, cookies: Record<string, string>) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer || cookies["sada_admin"];
  if (!token) throw ApiError.unauthorized("Admin authentication required");
  const payload = await verifyToken(token, "admin");
  if (!payload) throw ApiError.unauthorized("Admin session expired");
  const admin = await db.adminUser.findUnique({ where: { id: payload.sub } });
  if (!admin) throw ApiError.unauthorized("Admin not found");
  return admin;
}

/** Bootstrap the first admin from env on first run (username + password from .env). */
export async function ensureInitialAdmin() {
  const username = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!password) return null;
  const existing = await db.adminUser.count({});
  if (existing > 0) return null;
  const err = validateAdminPassword(password);
  if (err) {
    log.warn("initial-admin-password-rejected", { err });
    return null;
  }
  const admin = await db.adminUser.create({
    data: { id: randomBytes(12).toString("hex"), username, passwordHash: hashPassword(password), role: "superadmin" },
  });
  await appendAudit({ actorType: "system", action: "admin.bootstrap_created", targetId: admin.username });
  return admin;
}

// ---------- stats (spec §37) ----------

export async function getStats() {
  const [users, activeUsers7d, messages, chats, groups, channels, reports, mediaBytes, jobsFailed] = await Promise.all([
    db.user.count({ where: { deletedAt: null } }),
    db.user.count({ where: { lastSeenAt: { gt: new Date(Date.now() - 7 * 86400_000) } } }),
    db.message.count({ where: { status: "sent" } }),
    db.chat.count({ where: { deletedAt: null, type: "private" } }),
    db.chat.count({ where: { deletedAt: null, type: "group" } }),
    db.chat.count({ where: { deletedAt: null, type: "channel" } }),
    db.report.count({ where: { status: "open" } }),
    db.mediaObject.aggregate({ _sum: { size: true }, _count: { _all: true } }),
    db.job.count({ where: { status: "failed" } }),
  ]);
  // messages per day (7d trend)
  const since = new Date(Date.now() - 7 * 86400_000);
  const recent = await db.message.findMany({
    where: { createdAt: { gte: since }, status: "sent" },
    select: { createdAt: true },
  });
  const perDay: Record<string, number> = {};
  for (const m of recent) {
    const d = m.createdAt.toISOString().slice(0, 10);
    perDay[d] = (perDay[d] || 0) + 1;
  }
  return {
    users, activeUsers7d, messages, chats, groups, channels, openReports: reports,
    storageBytes: mediaBytes._sum.size || 0, mediaObjects: mediaBytes._count._all,
    failedJobs: jobsFailed,
    messagesPerDay: perDay,
    storageDriver: env.STORAGE_DRIVER,
  };
}

// ---------- user management ----------

export async function searchUsers(q: string, limit = 30) {
  const term = q.trim().toLowerCase();
  const where = term
    ? { OR: [{ username: { contains: term } }, { displayName: { contains: term } }, { phone: { contains: term } }] }
    : {};
  return db.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
    select: {
      id: true, phone: true, username: true, displayName: true, createdAt: true,
      bannedUntil: true, banReason: true, deletedAt: true, isVerified: true, lastSeenAt: true,
      _count: { select: { memberships: true, sentMessages: true } },
    },
  });
}

export async function banUser(adminId: string, userId: string, days: number | null, reason: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound("User not found");
  const bannedUntil = days ? new Date(Date.now() + days * 86400_000) : days === 0 ? null : new Date("2999-01-01");
  await db.user.update({ where: { id: userId }, data: { bannedUntil, banReason: reason || null } });
  if (bannedUntil) {
    // kill active sessions
    await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "admin-ban" } });
  }
  await appendAudit({
    actorType: "admin", actorId: adminId, action: days === 0 ? "admin.unbanned_user" : "admin.banned_user",
    targetType: "user", targetId: userId, detailJson: JSON.stringify({ days, reason }),
  });
  return { bannedUntil };
}

export async function deleteUserContent(adminId: string, messageId: string) {
  const msg = await db.message.findUnique({ where: { id: messageId } });
  if (!msg) throw ApiError.notFound("Message not found");
  await db.message.update({ where: { id: messageId }, data: { status: "deleted", deletedAt: new Date(), deletedBy: adminId } });
  await appendAudit({ actorType: "admin", actorId: adminId, action: "admin.deleted_message", targetType: "message", targetId: messageId });
  return { ok: true };
}

// ---------- reports queue ----------

export async function listReports(status: string, limit = 50) {
  return db.report.findMany({
    where: { status: status === "all" ? undefined : status },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
  });
}

export async function resolveReport(adminId: string, reportId: string, resolution: string, action?: "none" | "ban_user" | "delete_message" | "delete_chat", targetId?: string) {
  const report = await db.report.findUnique({ where: { id: reportId } });
  if (!report) throw ApiError.notFound("Report not found");
  if (report.status === "resolved" || report.status === "dismissed") {
    throw ApiError.conflict("ALREADY_RESOLVED", "Report already handled");
  }

  if (action === "ban_user") {
    const uid = report.targetType === "user" ? report.targetId : targetId;
    if (!uid) throw ApiError.badRequest("No user to ban");
    await db.user.update({ where: { id: uid }, data: { bannedUntil: new Date("2999-01-01"), banReason: `Report ${reportId}: ${report.category}` } });
    await db.session.updateMany({ where: { userId: uid, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "moderation" } });
  }
  if (action === "delete_message") {
    const mid = report.targetType === "message" ? report.targetId : targetId;
    if (mid) await db.message.update({ where: { id: mid }, data: { status: "deleted", deletedAt: new Date(), deletedBy: adminId } });
  }

  await db.report.update({
    where: { id: reportId },
    data: { status: resolution === "dismiss" ? "dismissed" : "resolved", handledBy: adminId, resolution, handledAt: new Date() },
  });
  await appendAudit({
    actorType: "admin", actorId: adminId, action: "admin.report_resolved", targetType: "report", targetId: reportId,
    detailJson: JSON.stringify({ resolution, action }),
  });
  return { ok: true };
}

// ---------- chats & audit ----------

export async function listChatsAdmin(type?: string, limit = 50) {
  return db.chat.findMany({
    where: { deletedAt: null, ...(type ? { type } : {}) },
    orderBy: { lastMessageAt: "desc" },
    take: Math.min(limit, 100),
    include: { _count: { select: { messages: true } } },
  });
}

export async function deleteChatAdmin(adminId: string, chatId: string, reason: string) {
  await db.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
  await appendAudit({ actorType: "admin", actorId: adminId, action: "admin.deleted_chat", targetType: "chat", targetId: chatId, detailJson: JSON.stringify({ reason }) });
  return { ok: true };
}

export async function listAuditLogs(limit = 100, action?: string) {
  return db.auditLog.findMany({
    where: action ? { action: { contains: action } } : undefined,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 300),
  });
}
