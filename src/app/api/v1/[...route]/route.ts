// ============================================================
// /api/v1 catch-all router — versioned REST API (spec §5).
// thin adapter: all logic lives in service modules.
// ============================================================
import { z } from "zod";
import { createApiHandler, ok, Router, setAuthCookie, clearAuthCookie, Ctx } from "@/lib/server/api";
import { ApiError } from "@/lib/server/errors";
import * as auth from "@/lib/server/services/auth.service";
import * as users from "@/lib/server/services/users.service";
import * as chats from "@/lib/server/services/chats.service";
import * as messages from "@/lib/server/services/messages.service";
import * as mediaSvc from "@/lib/server/services/media.service";
import * as sync from "@/lib/server/services/sync.service";
import * as notif from "@/lib/server/services/notifications.service";
import * as moderation from "@/lib/server/services/moderation.service";
import * as adminSvc from "@/lib/server/services/admin.service";
import { verifyMediaUrl } from "@/lib/server/security/signed-url";
import { enforceRateLimit } from "@/lib/server/security/rate-limit";
import { env } from "@/lib/server/env";
import { ensureInitialAdmin } from "@/lib/server/services/admin.service";
import { DEFAULT_STICKERS } from "@/lib/shared/constants";

const router = new Router();
// expose for tooling (openapi generation) without adding a route export
(globalThis as unknown as { __sadaRouter?: Router }).__sadaRouter = router;

// bootstrap admin once per process
let adminBootstrapped = false;
async function bootstrapAdmin() {
  if (!adminBootstrapped) {
    adminBootstrapped = true;
    await ensureInitialAdmin().catch(() => undefined);
  }
}

function me(ctx: Ctx) {
  if (!ctx.auth) throw ApiError.unauthorized();
  return ctx.auth;
}

// ---------------- AUTH (spec §15) ----------------

router.post("auth/request-otp", async (ctx) => {
  const body = await ctx.json<{ phone: string }>();
  const parsed = z.object({ phone: z.string().min(6).max(20) }).parse(body);
  return ok(await auth.requestOtp(parsed.phone, ctx.ip));
}, { auth: false });

router.post("auth/verify-otp", async (ctx) => {
  const body = await ctx.json<{ phone: string; code: string; deviceName?: string; platform?: string }>();
  const parsed = z
    .object({
      phone: z.string().min(6).max(20),
      code: z.string().min(4).max(8),
      deviceName: z.string().max(60).optional(),
      platform: z.string().max(20).optional(),
    })
    .parse(body);
  const result = await auth.verifyOtp(parsed.phone, parsed.code, parsed, ctx.ip);

  const res = ok(result);
  if (result.status === "ok" && result.accessToken && result.refreshToken) {
    setAuthCookie(res, "sada_session", result.accessToken, 60 * 30); // 30 min sliding; client refreshes
    setAuthCookie(res, "sada_refresh", result.refreshToken, 30 * 86400);
  }
  return res;
}, { auth: false });

router.post("auth/twofa", async (ctx) => {
  const body = await ctx.json<{ ticket: string; code: string; deviceName?: string; platform?: string }>();
  const result = await auth.verifyTwofa(body.ticket, body.code, body, ctx.ip);
  const res = ok(result);
  if (result.status === "ok" && result.accessToken && result.refreshToken) {
    setAuthCookie(res, "sada_session", result.accessToken, 60 * 30);
    setAuthCookie(res, "sada_refresh", result.refreshToken, 30 * 86400);
  }
  return res;
}, { auth: false });

router.post("auth/refresh", async (ctx) => {
  const body = await ctx.json<{ refreshToken?: string }>().catch(() => ({ refreshToken: undefined }));
  const token = body.refreshToken || ctx.cookies["sada_refresh"];
  if (!token) throw ApiError.unauthorized("No refresh token");
  const result = await auth.refreshSession(token, ctx.ip);
  const res = ok(result);
  setAuthCookie(res, "sada_session", result.accessToken, 60 * 30);
  setAuthCookie(res, "sada_refresh", result.refreshToken, 30 * 86400);
  return res;
}, { auth: false });

router.post("auth/logout", async (ctx) => {
  const m = me(ctx);
  await auth.revokeSession(m.userId, m.sessionId, "logout", ctx.ip);
  const res = ok({ loggedOut: true });
  res.headers.append("Set-Cookie", clearAuthCookie("sada_session"));
  res.headers.append("Set-Cookie", clearAuthCookie("sada_refresh"));
  return res;
});

router.post("auth/logout-all", async (ctx) => {
  const m = me(ctx);
  const count = await auth.revokeAllSessions(m.userId, m.sessionId, ctx.ip);
  return ok({ revoked: count });
});

router.get("auth/socket-token", async (ctx) => {
  const m = me(ctx);
  const { signSocketToken } = await import("@/lib/server/jwt");
  return ok({ token: await signSocketToken(m.userId, m.sessionId), realtimePort: process.env.REALTIME_PORT || 3003 });
});

// 2FA management
router.post("auth/2fa/setup", async (ctx) => ok(await auth.setupTwofa(me(ctx).userId)));
router.post("auth/2fa/enable", async (ctx) => {
  const body = await ctx.json<{ code: string }>();
  return ok(await auth.enableTwofa(me(ctx).userId, body.code));
});
router.post("auth/2fa/disable", async (ctx) => {
  const body = await ctx.json<{ code: string }>();
  return ok(await auth.disableTwofa(me(ctx).userId, body.code));
});

// ---------------- USERS ----------------

router.get("users/me", async (ctx) => {
  const m = me(ctx);
  const user = await users.getPublicUser(m.userId, m.userId);
  const settings = await users.getSettings(m.userId);
  const privacy = await users.getPrivacy(m.userId);
  return ok({ ...user, phone: m.user.phone, settings, privacy });
});

router.patch("users/me", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<Record<string, unknown>>();
  const patch = z
    .object({
      displayName: z.string().min(1).max(64).optional(),
      bio: z.string().max(280).optional(),
      username: z.string().regex(/^[a-zA-Z0-9_]{4,32}$/).nullable().optional(),
      avatarMediaId: z.string().nullable().optional(),
    })
    .parse(body);
  return ok(await users.updateProfile(m.userId, patch));
});

router.post("users/me/delete", async (ctx) => {
  const m = me(ctx);
  return ok(await auth.requestAccountDeletion(m.userId));
});

router.get("users/me/export", async (ctx) => {
  const m = me(ctx);
  const data = await users.exportMyData(m.userId);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="sada-export-${m.userId}.json"`,
    },
  });
});

router.get("users/settings", async (ctx) => ok(await users.getSettings(me(ctx).userId)));
router.patch("users/settings", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<Record<string, unknown>>();
  return ok(await users.updateSettings(m.userId, body));
});

router.get("users/privacy", async (ctx) => ok(await users.getPrivacy(me(ctx).userId)));
router.patch("users/privacy", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<Record<string, unknown>>();
  return ok(await users.setPrivacy(m.userId, body as Partial<Record<string, string | boolean>>));
});

router.get("users/search", async (ctx) => {
  const m = me(ctx);
  const q = ctx.query.get("q") || "";
  return ok(await users.searchUsers(m.userId, q));
});

router.post("users/contacts/sync", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ phoneHashes: string[]; names?: Record<string, string> }>();
  return ok(await users.syncContacts(m.userId, body));
});
router.get("users/contacts", async (ctx) => ok(await users.listContacts(me(ctx).userId)));

router.post("users/:id/block", async (ctx) => ok(await users.blockUser(me(ctx).userId, ctx.params.id)));
router.post("users/:id/unblock", async (ctx) => ok(await users.unblockUser(me(ctx).userId, ctx.params.id)));
router.get("users/blocked", async (ctx) => ok(await users.listBlocked(me(ctx).userId)));
router.get("users/:id", async (ctx) => ok(await users.getPublicUser(me(ctx).userId, ctx.params.id)));

// ---------------- CHATS ----------------

router.get("chats", async (ctx) => {
  const m = me(ctx);
  return ok(
    await chats.listChats(m.userId, {
      folderId: ctx.query.get("folderId") || undefined,
      archived: ctx.query.get("archived") === "true",
      query: ctx.query.get("q") || undefined,
    })
  );
});

router.post("chats/private", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ userId: string }>();
  return ok(await chats.createPrivateChat(m.userId, body.userId));
});

router.post("chats/group", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<chats.CreateGroupInput>();
  return ok(await chats.createGroupOrChannel(m.userId, { ...body, type: "group" }));
});

router.post("chats/channel", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<chats.CreateGroupInput>();
  return ok(await chats.createGroupOrChannel(m.userId, { ...body, type: "channel" }));
});

router.post("chats/saved", async (ctx) => ok(await chats.getOrCreateSavedChat(me(ctx).userId)));

router.get("chats/:id", async (ctx) => ok(await chats.getChatCard(me(ctx).userId, ctx.params.id)));

router.patch("chats/:id", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<Record<string, unknown>>();
  return ok(
    await chats.updateChatInfo(m.userId, ctx.params.id, {
      title: body.title as string | undefined,
      about: body.about as string | undefined,
      avatarMediaId: body.avatarMediaId as string | null | undefined,
      username: body.username as string | null | undefined,
      isPublic: body.isPublic as boolean | undefined,
      slowModeSeconds: body.slowModeSeconds as number | undefined,
      defaultPerms: body.defaultPerms as Record<string, boolean> | undefined,
    })
  );
});

router.delete("chats/:id", async (ctx) => ok(await chats.leaveChat(me(ctx).userId, ctx.params.id)));

router.post("chats/:id/members", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ userIds: string[] }>();
  return ok(await chats.addMembers(m.userId, ctx.params.id, body.userIds || []));
});
router.get("chats/:id/members", async (ctx) => {
  const m = me(ctx);
  return ok(await chats.listMembers(m.userId, ctx.params.id, { limit: Number(ctx.query.get("limit")) || 50, offset: Number(ctx.query.get("offset")) || 0 }));
});
router.delete("chats/:id/members/:userId", async (ctx) => ok(await chats.removeMember(me(ctx).userId, ctx.params.id, ctx.params.userId)));
router.post("chats/:id/members/:userId/role", async (ctx) => {
  const body = await ctx.json<{ role: string }>();
  return ok(await chats.setMemberRole(me(ctx).userId, ctx.params.id, ctx.params.userId, body.role));
});
router.post("chats/:id/members/:userId/restrict", async (ctx) => {
  const body = await ctx.json<{ days: number | null }>();
  const until = body.days ? new Date(Date.now() + body.days * 86400_000) : null;
  return ok(await chats.restrictMember(me(ctx).userId, ctx.params.id, ctx.params.userId, until));
});
router.post("chats/:id/leave", async (ctx) => ok(await chats.leaveChat(me(ctx).userId, ctx.params.id)));

router.post("chats/:id/flags", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ pinned?: boolean; archived?: boolean; mutedUntil?: string | null }>();
  return ok(
    await chats.setChatFlags(m.userId, ctx.params.id, {
      pinned: body.pinned,
      archived: body.archived,
      mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : body.mutedUntil === null ? null : undefined,
    })
  );
});

router.post("chats/:id/read", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ upToSeq: number }>();
  return ok(await chats.markRead(m.userId, ctx.params.id, body.upToSeq));
});

router.get("chats/:id/draft", async (ctx) => {
  await chats.requireMembership(me(ctx).userId, ctx.params.id);
  const d = await (await import("@/lib/db")).db.draft.findUnique({ where: { chatId_userId: { chatId: ctx.params.id, userId: me(ctx).userId } } });
  return ok({ text: d?.text || "", replyToId: d?.replyToId || null });
});
router.post("chats/:id/draft", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ text: string; replyToId?: string | null }>();
  return ok(await chats.setDraft(m.userId, ctx.params.id, body.text || "", body.replyToId));
});

router.post("chats/:id/invites", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ expiresInDays?: number; usageLimit?: number }>().catch(() => ({}));
  return ok(await chats.createInvite(m.userId, ctx.params.id, body));
});
router.get("chats/:id/invites", async (ctx) => ok(await chats.listInvites(me(ctx).userId, ctx.params.id)));
router.post("invites/:inviteId/revoke", async (ctx) => ok(await chats.revokeInvite(me(ctx).userId, ctx.params.inviteId)));
router.get("invites/:code", async (ctx) => ok(await chats.getInviteInfo(ctx.params.code)), { auth: false });
router.post("invites/:code/join", async (ctx) => ok(await chats.joinByInvite(me(ctx).userId, ctx.params.code)));

router.get("chats/:id/join-requests", async (ctx) => ok(await chats.listJoinRequests(me(ctx).userId, ctx.params.id)));
router.post("join-requests/:requestId", async (ctx) => {
  const body = await ctx.json<{ approve: boolean }>();
  return ok(await chats.handleJoinRequest(me(ctx).userId, ctx.params.requestId, body.approve));
});

router.get("chats/public", async (ctx) => ok(await chats.searchPublicChats(ctx.query.get("q") || "")));
router.post("chats/public/:username/join", async (ctx) => ok(await chats.joinPublicChat(me(ctx).userId, ctx.params.username)));

// folders
router.get("folders", async (ctx) => ok(await chats.listFolders(me(ctx).userId)));
router.post("folders", async (ctx) => {
  const body = await ctx.json<{ name: string; icon?: string }>();
  return ok(await chats.createFolder(me(ctx).userId, body.name, body.icon));
});
router.patch("folders/:id", async (ctx) => {
  const body = await ctx.json<{ name?: string; icon?: string; chatIds?: string[] }>();
  return ok(await chats.updateFolder(me(ctx).userId, ctx.params.id, body));
});
router.delete("folders/:id", async (ctx) => ok(await chats.deleteFolder(me(ctx).userId, ctx.params.id)));

// ---------------- MESSAGES ----------------

router.get("chats/:id/messages", async (ctx) => {
  const m = me(ctx);
  return ok(
    await messages.listMessages(m.userId, ctx.params.id, {
      before: ctx.query.get("before") ? Number(ctx.query.get("before")) : undefined,
      after: ctx.query.get("after") ? Number(ctx.query.get("after")) : undefined,
      limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
    })
  );
});

router.post("chats/:id/messages", async (ctx) => {
  const m = me(ctx);
  enforceRateLimit("messages:send", m.userId);
  const body = await ctx.json<Record<string, unknown>>();
  const input = z
    .object({
      text: z.string().max(4096).optional(),
      clientMsgId: z.string().max(64).optional(),
      replyToId: z.string().max(64).optional(),
      attachments: z
        .array(z.object({ mediaId: z.string(), kind: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(), filename: z.string().optional() }))
        .max(10)
        .optional(),
      scheduledAt: z.string().optional(),
      forwardOf: z.object({ chatId: z.string(), messageId: z.string() }).optional(),
    })
    .parse(body);
  return ok(await messages.sendMessage(m.userId, ctx.params.id, input));
});

router.get("messages/:id", async (ctx) => {
  const m = me(ctx);
  const msg = await (await import("@/lib/db")).db.message.findUnique({ where: { id: ctx.params.id } });
  if (!msg) throw ApiError.notFound("Message not found");
  return ok((await messages.listMessages(m.userId, msg.chatId, { after: msg.seq - 1, limit: 1 })).items[0]);
});

router.patch("messages/:id", async (ctx) => {
  const body = await ctx.json<{ text: string }>();
  return ok(await messages.editMessage(me(ctx).userId, ctx.params.id, body.text));
});
router.delete("messages/:id", async (ctx) => ok(await messages.deleteMessage(me(ctx).userId, ctx.params.id)));
router.post("messages/:id/reactions", async (ctx) => {
  const body = await ctx.json<{ emoji: string | null }>();
  return ok(await messages.setReaction(me(ctx).userId, ctx.params.id, body.emoji));
});
router.post("messages/:id/pin", async (ctx) => {
  const body = await ctx.json<{ pinned: boolean }>();
  return ok(await messages.pinMessage(me(ctx).userId, ctx.params.id, body.pinned));
});
router.get("chats/:id/pinned", async (ctx) => ok(await messages.listPinned(me(ctx).userId, ctx.params.id)));
router.post("messages/forward", async (ctx) => {
  const body = await ctx.json<{ messageIds: string[]; chatIds: string[] }>();
  return ok(await messages.forwardMessages(me(ctx).userId, body.messageIds, body.chatIds));
});
router.get("messages/:id/comments", async (ctx) => {
  const m = me(ctx);
  return ok(await messages.listComments(m.userId, ctx.params.id, { before: ctx.query.get("before") ? Number(ctx.query.get("before")) : undefined }));
});
router.get("search/messages", async (ctx) => {
  const m = me(ctx);
  return ok(await messages.searchMessages(m.userId, ctx.query.get("q") || "", ctx.query.get("chatId") || undefined));
});
router.get("search/global", async (ctx) => {
  const m = me(ctx);
  const q = ctx.query.get("q") || "";
  const [foundUsers, foundChats, foundMessages] = await Promise.all([
    users.searchUsers(m.userId, q),
    chats.searchPublicChats(q),
    messages.searchMessages(m.userId, q, undefined, 15),
  ]);
  return ok({ users: foundUsers, chats: foundChats, messages: foundMessages });
});

// ---------------- MEDIA ----------------

router.post("media/upload-session", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ kind: string; filename: string; mime?: string; size: number; checksum?: string; partCount?: number }>();
  return ok(await mediaSvc.createUploadSession(m.userId, body));
});

router.put("media/upload/:id", async (ctx) => {
  const m = me(ctx);
  const part = ctx.query.get("part") ? Number(ctx.query.get("part")) : 1;
  const bytes = await ctx.bytes();
  return ok(await mediaSvc.putUploadPart(m.userId, ctx.params.id, bytes, part));
});

router.post("media/upload/:id/abort", async (ctx) => ok(await mediaSvc.abortUpload(me(ctx).userId, ctx.params.id)));
router.post("media/upload/:id/complete", async (ctx) => ok(await mediaSvc.completeUpload(me(ctx).userId, ctx.params.id)));

// signed media access (spec §8-9) — public route, HMAC-verified
router.get("media/file", async (ctx) => {
  const p = {
    m: ctx.query.get("m") || "",
    v: ctx.query.get("v") || "original",
    u: ctx.query.get("u") || "",
    e: ctx.query.get("e") || "",
    s: ctx.query.get("s") || "",
  };
  let scope;
  try {
    scope = verifyMediaUrl(p);
  } catch (e) {
    throw new ApiError(403, "INVALID_SIGNATURE", e instanceof Error && e.message === "expired" ? "URL expired" : "Invalid signature");
  }
  return mediaSvc.serveMedia(p, ctx.req.headers.get("range"));
}, { auth: false });

// issue a signed URL for a media the requester may access (avatars for all
// authenticated users; other media require ownership or chat membership)
router.get("media/signed", async (ctx) => {
  const m = me(ctx);
  const mediaId = ctx.query.get("m") || "";
  const variant = ctx.query.get("v") || "original";
  const url = await mediaSvc.issueSignedUrl(m.userId, mediaId, variant);
  return ok({ url });
});

router.get("media/stats", async (ctx) => ok(await mediaSvc.storageStats(me(ctx).userId)));

// ---------------- SYNC (spec §33) ----------------

router.get("sync", async (ctx) => {
  const m = me(ctx);
  const since = Number(ctx.query.get("since") || 0);
  return ok(await sync.getSyncEvents(m.userId, since));
});
router.get("sync/cursor", async (ctx) => ok({ cursor: await sync.getLatestSeq() }));
router.post("sync/cursor", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ seq: number }>();
  return ok(await sync.updateDeviceCursor(m.sessionId, body.seq));
});

// ---------------- NOTIFICATIONS ----------------

router.get("notifications", async (ctx) => {
  const m = me(ctx);
  return ok(await notif.listNotifications(m.userId, { unreadOnly: ctx.query.get("unread") === "true" }));
});
router.post("notifications/read", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ ids?: string[] }>().catch(() => ({ ids: undefined }));
  return ok(await notif.markNotificationsRead(m.userId, body.ids));
});
router.get("notifications/prefs", async (ctx) => ok(await notif.getNotifPrefs(me(ctx).userId)));
router.patch("notifications/prefs", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<Record<string, unknown>>();
  return ok(await notif.setNotifPrefs(m.userId, body as never));
});
router.post("notifications/push/subscribe", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ endpoint: string; keys: { p256dh: string; auth: string } }>();
  return ok(await notif.subscribePush(m.userId, body, m.sessionId));
});
router.post("notifications/push/unsubscribe", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ endpoint: string }>();
  return ok(await notif.unsubscribePush(m.userId, body.endpoint));
});
router.post("notifications/fcm/register", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ token: string }>();
  return ok(await notif.registerFcmToken(m.userId, m.sessionId, body.token));
});
router.get("notifications/vapid-key", async (ctx) => ok({ publicKey: notif.vapidPublicKeyForClient() }), { auth: false });

// ---------------- SESSIONS ----------------

router.get("sessions", async (ctx) => ok(await auth.listSessions(me(ctx).userId, me(ctx).sessionId)));
router.post("sessions/:id/revoke", async (ctx) => {
  const m = me(ctx);
  return ok(await auth.revokeSession(m.userId, ctx.params.id, "user-revoked", ctx.ip));
});
router.post("sessions/revoke-all", async (ctx) => {
  const m = me(ctx);
  return ok({ revoked: await auth.revokeAllSessions(m.userId, m.sessionId, ctx.ip) });
});

// ---------------- MODERATION (spec §22) ----------------

router.post("reports", async (ctx) => {
  const m = me(ctx);
  const body = await ctx.json<{ targetType: "user" | "message" | "chat"; targetId: string; category: string; description?: string }>();
  return ok(await moderation.createReport(m.userId, body));
});

// ---------------- ADMIN (separate auth — spec §37) ----------------

router.post("admin/login", async (ctx) => {
  await bootstrapAdmin();
  const body = await ctx.json<{ username: string; password: string; totp?: string }>();
  const result = await adminSvc.adminLogin(body.username, body.password, body.totp, ctx.ip);
  const res = ok(result);
  setAuthCookie(res, "sada_admin", result.token, 8 * 3600);
  return res;
}, { auth: false });

router.get("admin/me", async (ctx) => {
  const admin = await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok({ id: admin.id, username: admin.username, role: admin.role, totpEnabled: admin.totpEnabled });
});

router.get("admin/stats", async (ctx) => {
  await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok(await adminSvc.getStats());
});
router.get("admin/users", async (ctx) => {
  await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok(await adminSvc.searchUsers(ctx.query.get("q") || ""));
});
router.post("admin/users/:id/ban", async (ctx) => {
  const admin = await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  const body = await ctx.json<{ days: number | null; reason?: string }>();
  return ok(await adminSvc.banUser(admin.id, ctx.params.id, body.days, body.reason || ""));
});
router.get("admin/reports", async (ctx) => {
  await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok(await adminSvc.listReports(ctx.query.get("status") || "open"));
});
router.post("admin/reports/:id/resolve", async (ctx) => {
  const admin = await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  const body = await ctx.json<{ resolution: string; action?: "none" | "ban_user" | "delete_message" | "delete_chat"; targetId?: string }>();
  return ok(await adminSvc.resolveReport(admin.id, ctx.params.id, body.resolution, body.action, body.targetId));
});
router.get("admin/chats", async (ctx) => {
  await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok(await adminSvc.listChatsAdmin(ctx.query.get("type") || undefined));
});
router.post("admin/chats/:id/delete", async (ctx) => {
  const admin = await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  const body = await ctx.json<{ reason?: string }>().catch(() => ({ reason: "" }));
  return ok(await adminSvc.deleteChatAdmin(admin.id, ctx.params.id, body.reason || ""));
});
router.get("admin/audit-logs", async (ctx) => {
  await adminSvc.requireAdmin(ctx.req, ctx.cookies);
  return ok(await adminSvc.listAuditLogs(Number(ctx.query.get("limit")) || 100, ctx.query.get("action") || undefined));
});

// ---------------- META ----------------

router.get("meta", async () => {
  return ok({
    name: "Sada Messenger API",
    version: "v1",
    stickers: DEFAULT_STICKERS,
    limits: { maxMessageLen: 4096, maxFileBytes: 512 * 1024 * 1024 },
    otpDevEcho: env.OTP_DEV_ECHO,
  });
}, { auth: false });

router.get("health", async () => {
  const { db } = await import("@/lib/db");
  await db.$queryRaw`SELECT 1`;
  return ok({ status: "healthy", db: "up", ts: new Date().toISOString() });
}, { auth: false });

export const GET = createApiHandler(router);
export const POST = createApiHandler(router);
export const PATCH = createApiHandler(router);
export const PUT = createApiHandler(router);
export const DELETE = createApiHandler(router);
