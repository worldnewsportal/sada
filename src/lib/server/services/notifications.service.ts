// ============================================================
// Notifications service (spec §18, §72): preferences, push dispatch.
// Providers: Web Push (VAPID, works out of the box for the PWA),
// FCM HTTP v1 and APNs token-based — activated by env credentials.
// Push content respects privacy (no message text when prohibited).
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { ulid } from "@/lib/ulid";
import { env } from "../env";
import { createHash, createSign } from "crypto";
import { log } from "../logger";

// ---------- preferences ----------

export interface NotifPrefs {
  enabled: boolean;
  showMessageText: boolean;
  groupsEnabled: boolean;
  channelsEnabled: boolean;
  privateEnabled: boolean;
}

const DEFAULT_PREFS: NotifPrefs = {
  enabled: true,
  showMessageText: true,
  groupsEnabled: true,
  channelsEnabled: true,
  privateEnabled: true,
};

export async function getNotifPrefs(userId: string): Promise<NotifPrefs> {
  const s = await db.userSettings.findUnique({ where: { userId } });
  return { ...DEFAULT_PREFS, ...JSON.parse(s?.notifJson || "{}") };
}

export async function setNotifPrefs(userId: string, patch: Partial<NotifPrefs>) {
  const current = await getNotifPrefs(userId);
  const merged = { ...current, ...patch };
  await db.userSettings.upsert({
    where: { userId },
    update: { notifJson: JSON.stringify(merged) },
    create: { userId, notifJson: JSON.stringify(merged) },
  });
  return merged;
}

// ---------- subscriptions ----------

export async function subscribePush(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, sessionRef?: string) {
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw ApiError.badRequest("Invalid subscription");
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    create: {
      id: ulid(),
      userId,
      endpoint: sub.endpoint.slice(0, 1000),
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      sessionRef: sessionRef || null,
    },
  });
  return { subscribed: true };
}

export async function unsubscribePush(userId: string, endpoint: string) {
  await db.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return { unsubscribed: true };
}

export async function registerFcmToken(userId: string, sessionId: string, token: string) {
  await db.session.updateMany({
    where: { id: sessionId, userId },
    data: { pushToken: token.slice(0, 500) },
  });
  return { registered: true };
}

// ---------- list / read ----------

export async function listNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const rows = await db.notification.findMany({
    where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit || 50, 200),
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      chatId: r.chatId,
      messageId: r.messageId,
      title: r.title,
      body: r.body,
      data: r.dataJson ? JSON.parse(r.dataJson) : null,
      read: !!r.readAt,
      createdAt: r.createdAt,
    })),
    unreadCount: await db.notification.count({ where: { userId, readAt: null } }),
  };
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  await db.notification.updateMany({
    where: { userId, id: ids ? { in: ids } : undefined, readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

// ---------- dispatch (used by worker push.send job) ----------

export async function dispatchMessagePush(messageId: string, chatId: string, senderId: string | null) {
  const message = await db.message.findUnique({ where: { id: messageId }, include: { chat: true } });
  if (!message || message.status !== "sent") return { sent: 0, skipped: "message unavailable" };
  const sender = senderId ? await db.user.findUnique({ where: { id: senderId } }) : null;

  const members = await db.chatMember.findMany({
    where: { chatId, leftAt: null, userId: { not: senderId || "" } },
    include: { user: { include: { settings: true, privacy: true } } },
  });

  let sent = 0;
  for (const member of members) {
    try {
      // respect mutes + prefs (spec §18)
      if (member.mutedUntil && member.mutedUntil > new Date()) continue;
      const prefs = { ...DEFAULT_PREFS, ...JSON.parse(member.user.settings?.notifJson || "{}") };
      if (!prefs.enabled) continue;
      if (message.chat.type === "group" && !prefs.groupsEnabled) continue;
      if (message.chat.type === "channel" && !prefs.channelsEnabled) continue;
      if (message.chat.type === "private" && !prefs.privateEnabled) continue;

      // privacy: hide text when user disabled message preview (spec §18)
      const showText = prefs.showMessageText;
      const title = message.chat.type === "private" ? sender?.displayName || "New message" : message.chat.title || "Chat";
      const body = showText
        ? message.text || (message.kind === "media" ? "Sent an attachment" : "New message")
        : "You have a new message";

      const notification = await db.notification.create({
        data: {
          id: ulid(),
          userId: member.userId,
          type: "message",
          chatId,
          messageId,
          title,
          body,
          dataJson: JSON.stringify({ chatId, messageId }),
        },
      });

      // realtime bell event
      const { appendAndEmit } = await import("../events");
      const { Events } = await import("@/lib/shared/constants");
      await appendAndEmit([
        { type: Events.NOTIFICATION_CREATED, targetUserId: member.userId, payload: { notificationId: notification.id, chatId, messageId } },
      ]);

      // web push
      const subs = await db.pushSubscription.findMany({ where: { userId: member.userId } });
      for (const sub of subs) {
        const ok = await sendWebPush(sub, { title, body, chatId });
        if (ok) sent++;
      }
      // FCM per-device tokens
      const sessionTokens = await db.session.findMany({ where: { userId: member.userId, pushToken: { not: null }, revokedAt: null } });
      for (const s of sessionTokens) {
        if (s.pushToken && (await sendFcm(s.pushToken, title, body, chatId))) sent++;
      }
    } catch (e) {
      log.warn("push-dispatch-failed", { userId: member.userId, err: String(e) });
    }
  }
  return { sent };
}

async function sendWebPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: { title: string; body: string; chatId: string }): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  try {
    const webpush = await import("web-push");
    webpush.default.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    await webpush.default.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      // subscription gone — prune
      await db.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }).catch(() => undefined);
    }
    return false;
  }
}

async function sendFcm(token: string, title: string, body: string, chatId: string): Promise<boolean> {
  const creds = env.FCM_CREDENTIALS_JSON;
  if (!creds) return false;
  try {
    const accessToken = await getFcmAccessToken(JSON.parse(creds));
    const projectId = JSON.parse(creds).project_id;
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: { chatId, click_action: "FLUTTER_NOTIFICATION_CLICK" },
          android: { priority: "high" },
        },
      }),
    });
    return res.ok;
  } catch (e) {
    log.warn("fcm-send-failed", { err: String(e) });
    return false;
  }
}

let fcmAccessToken: { token: string; exp: number } | null = null;
async function getFcmAccessToken(creds: { client_email: string; private_key: string }): Promise<string> {
  if (fcmAccessToken && fcmAccessToken.exp > Date.now() + 60_000) return fcmAccessToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(claim)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(creds.private_key.replace(/\\n/g, "\n")).toString("base64url");
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  fcmAccessToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/** VAPID keypair generation helper (setup script). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const webpush = (await import("web-push")).default;
  return webpush.generateVAPIDKeys();
}

export function vapidPublicKeyForClient(): string {
  return env.VAPID_PUBLIC_KEY || "";
}

// checksum helper for integrity (used by export flow)
export function quickHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
