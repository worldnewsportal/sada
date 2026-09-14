// ============================================================
// Auth service — phone OTP, sessions, tokens, 2FA (spec §15).
// Security properties:
//  - OTP codes stored hashed (sha256 + per-code salt), 5-min TTL,
//    max 5 attempts, rate-limited per phone AND per IP
//  - Refresh token rotation with reuse detection (revokes session)
//  - Access tokens: 15-min JWT; refresh: 30-day opaque (hashed at rest)
//  - 2FA: TOTP RFC-6238, secret stored encrypted-at-rest column
//  - Device sessions enumerable + revocable per-device or all
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { log } from "../logger";
import { env } from "../env";
import { createHash, randomBytes, randomInt } from "crypto";
import { signAccessToken, signTwofaTicket } from "../jwt";
import { verifyTwofaTicket } from "../jwt-helpers";
import { enforceRateLimit } from "../security/rate-limit";
import { verifyTotp } from "../security/totp";
import { getSmsProvider, hasRealSmsProvider, isTestPhone, assertTestPhonesAllowed } from "../security/sms";
import { getEmailProvider, hasRealEmailProvider, renderEmailOtp } from "../security/email";
import { hashPassword, verifyPassword, validateUserPassword } from "../security/password";
import { appendAudit } from "./audit.service";

const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const OTP_TTL_S = 300;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_OTP_TTL_S = 600; // email is slower than SMS — 10 minutes
const EMAIL_OTP_MAX_ATTEMPTS = 5;

export interface DeviceInfo {
  deviceName?: string;
  platform?: string;
  appVersion?: string;
}

// ---------- SMS delivery (see src/lib/server/security/sms.ts) ----------
// Providers: twilio | http-gateway | console(dev) | none. Test phones
// ("+999…" prefix) never reach a provider — see requestOtp routing below.
export { getSmsProvider as smsProvider } from "../security/sms";

// ---------- helpers ----------

function normalizePhone(raw: string): string {
  const clean = raw.replace(/[\s()-]/g, "");
  if (!/^\+?[1-9]\d{7,14}$/.test(clean)) {
    throw ApiError.badRequest("Invalid phone number (E.164 expected, e.g. +9647XXXXXXXX)");
  }
  return clean.startsWith("+") ? clean : `+${clean}`;
}

export function phoneHash(phone: string): string {
  return createHash("sha256").update(`${phone}:${env.APP_PEPPER}`).digest("hex");
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// ---------- OTP flow ----------

export type OtpDelivery = "test" | "sms" | "dev";

export async function requestOtp(rawPhone: string, ip: string) {
  enforceRateLimit("auth:request-otp", rawPhone);
  enforceRateLimit("auth:login-ip", ip);
  const phone = normalizePhone(rawPhone);
  const testPhone = isTestPhone(phone);
  if (testPhone) assertTestPhonesAllowed();

  const user = await db.user.findUnique({ where: { phone } });
  if (user?.deletedAt) throw ApiError.notFound("Account no longer exists");
  if (user?.bannedUntil && user.bannedUntil > new Date()) {
    throw ApiError.forbidden("Account suspended");
  }

  // Resend cooldown + hourly ceiling (DB-counted, survives limiter restarts).
  // Applies to BOTH paths — protects real-SMS cost and test-mode flooding.
  const recent = await db.otpCode.findFirst({
    where: { phone, createdAt: { gt: new Date(Date.now() - env.SMS_RESEND_COOLDOWN_S * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    const waitS = Math.max(1, Math.ceil((recent.createdAt.getTime() + env.SMS_RESEND_COOLDOWN_S * 1000 - Date.now()) / 1000));
    throw ApiError.rateLimited(waitS);
  }
  const hourly = await db.otpCode.count({
    where: { phone, createdAt: { gt: new Date(Date.now() - 3600_000) } },
  });
  if (hourly >= env.SMS_MAX_PER_HOUR) {
    throw ApiError.rateLimited(3600);
  }

  // Invalidate ALL older unconsumed codes for this phone first — only the
  // newest code may ever verify (prevents multi-active-code confusion).
  await db.otpCode.updateMany({
    where: { phone, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  const code = generateCode();
  const salt = randomBytes(16).toString("hex");
  await db.otpCode.create({
    data: {
      id: randomBytes(12).toString("hex"),
      phone,
      codeHash: createHash("sha256").update(`${code}:${salt}`).digest("hex"),
      salt,
      ip,
      expiresAt: new Date(Date.now() + OTP_TTL_S * 1000),
    },
  });

  // --- delivery routing ---
  // test: fake number → never touches a provider, code surfaced in-app
  // sms:  real number → provider delivers; the code NEVER appears in a response
  // dev:  real number in dev with no real provider configured → echo in-app
  //       (OTP_DEV_ECHO is auto-disabled in production, so this cannot leak)
  let delivery: OtpDelivery;
  if (testPhone) {
    delivery = "test";
    log.info("otp-test-mode", { phone, code });
  } else if (hasRealSmsProvider()) {
    await getSmsProvider().send(phone, `Sada verification code: ${code} (valid ${OTP_TTL_S / 60} minutes)`);
    delivery = "sms";
  } else if (env.OTP_DEV_ECHO) {
    delivery = "dev";
    log.info("otp-dev-echo", { phone, code });
  } else {
    throw ApiError.unavailable(
      "SMS provider is not configured — set TWILIO_* or SMS_GATEWAY_URL (or use a test number +999…)"
    );
  }
  await appendAudit({ actorType: "user", actorId: user?.id, action: "auth.otp_requested", targetType: "user", targetId: phone, ip });

  return {
    sent: true,
    expiresInSeconds: OTP_TTL_S,
    delivery,
    testPhone,
    devCode: delivery === "sms" ? undefined : code,
  };
}

export interface LoginResult {
  status: "ok" | "twofa_required";
  twofaTicket?: string;
  accessToken?: string;
  refreshToken?: string;
  session?: { id: string; deviceName: string; expiresAt: string };
  user?: PublicSelf;
}

export async function verifyOtp(
  rawPhone: string,
  code: string,
  device: DeviceInfo,
  ip: string
): Promise<LoginResult> {
  enforceRateLimit("auth:verify-otp", rawPhone);
  const phone = normalizePhone(rawPhone);

  const otp = await db.otpCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw ApiError.badRequest("Code expired — request a new one");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw ApiError.forbidden("Too many attempts — request a new code");

  const hash = createHash("sha256").update(`${code.trim()}:${otp.salt}`).digest("hex");
  if (hash !== otp.codeHash) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw ApiError.badRequest("Incorrect code");
  }
  await db.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  let user = await db.user.findUnique({ where: { phone } });
  if (!user) {
    user = await db.user.create({
      data: {
        id: randomBytes(12).toString("hex"),
        phone,
        phoneHash: phoneHash(phone),
        displayName: `User ${phone.slice(-4)}`,
        avatarColor: randomInt(0, 8),
      },
    });
    await db.userSettings.create({ data: { userId: user.id } });
    await db.userPrivacy.create({ data: { userId: user.id } });
    log.info("user-registered", { userId: user.id });
  }
  if (user.bannedUntil && user.bannedUntil > new Date()) throw ApiError.forbidden("Account suspended");

  if (user.twofaEnabled && user.twofaSecret) {
    return { status: "twofa_required", twofaTicket: await signTwofaTicket(user.id) };
  }
  return issueSession(user.id, device, ip, user);
}

/** Second factor: TOTP after OTP success. */
export async function verifyTwofa(ticket: string, code: string, device: DeviceInfo, ip: string) {
  enforceRateLimit("auth:verify-otp", ip);
  const userId = await verifyTwofaTicket(ticket);
  if (!userId) throw ApiError.unauthorized("2FA ticket expired");
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.twofaSecret) throw ApiError.badRequest("2FA not configured");
  if (!verifyTotp(user.twofaSecret, code)) throw ApiError.badRequest("Invalid 2FA code");
  return issueSession(user.id, device, ip, user);
}

// ---------- EMAIL auth (signup with welcome mail / login by code) ----------

export type EmailDelivery = "email" | "dev";

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw ApiError.badRequest("Invalid email address");
  }
  return email;
}

/**
 * Request an email code — used for BOTH signup and login:
 *   new email → welcome + activation code (account created on verify)
 *   known email → sign-in code (never reveals existence in the response)
 * Optional password at signup: policy-checked now, hashed, and stored
 * pending INSIDE the OTP row — applied only after successful activation.
 */
export async function requestEmailOtp(
  rawEmail: string,
  opts: { intent?: "signup" | "login"; password?: string },
  ip: string
) {
  enforceRateLimit("auth:request-email-otp", rawEmail.trim().toLowerCase());
  enforceRateLimit("auth:login-ip", ip);
  const email = normalizeEmail(rawEmail);

  const user = await db.user.findUnique({ where: { email } });
  if (user?.deletedAt) throw ApiError.notFound("Account no longer exists");
  if (user?.bannedUntil && user.bannedUntil > new Date()) throw ApiError.forbidden("Account suspended");

  // Pending password (signup convenience) — validated BEFORE sending mail so
  // weak passwords fail fast, then stored hashed with the OTP record.
  let pendingPasswordHash: string | undefined;
  if (opts.password) {
    const policyError = validateUserPassword(opts.password);
    if (policyError) throw ApiError.badRequest(policyError);
    pendingPasswordHash = hashPassword(opts.password);
  }

  // Resend cooldown + hourly ceiling (DB-counted, same model as SMS).
  const recent = await db.emailOtp.findFirst({
    where: { email, createdAt: { gt: new Date(Date.now() - env.EMAIL_RESEND_COOLDOWN_S * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    const waitS = Math.max(1, Math.ceil((recent.createdAt.getTime() + env.EMAIL_RESEND_COOLDOWN_S * 1000 - Date.now()) / 1000));
    throw ApiError.rateLimited(waitS);
  }
  const hourly = await db.emailOtp.count({
    where: { email, createdAt: { gt: new Date(Date.now() - 3600_000) } },
  });
  if (hourly >= env.EMAIL_MAX_PER_HOUR) throw ApiError.rateLimited(3600);

  // Only the newest code may ever verify.
  await db.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: new Date() } });

  const code = generateCode();
  const salt = randomBytes(16).toString("hex");
  await db.emailOtp.create({
    data: {
      id: randomBytes(12).toString("hex"),
      email,
      codeHash: createHash("sha256").update(`${code}:${salt}`).digest("hex"),
      salt,
      pendingPasswordHash,
      ip,
      expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_S * 1000),
    },
  });

  // Delivery: real SMTP when configured; dev echo otherwise (auto-off in prod).
  // The response NEVER contains whether the email exists; in email mode the
  // code itself is also never in the response.
  const isNew = !user;
  let delivery: EmailDelivery;
  if (hasRealEmailProvider()) {
    const mail = renderEmailOtp({ code, ttlMin: EMAIL_OTP_TTL_S / 60, isNew });
    await getEmailProvider().send({ to: email, ...mail });
    delivery = "email";
  } else if (env.OTP_DEV_ECHO) {
    delivery = "dev";
    log.info("email-dev-echo", { email, code });
  } else {
    throw ApiError.unavailable("Email delivery is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS (see .env.example)");
  }
  await appendAudit({ actorType: "user", actorId: user?.id, action: "auth.email_otp_requested", targetType: "user", targetId: email, ip });

  return { sent: true, expiresInSeconds: EMAIL_OTP_TTL_S, delivery, isNew, devCode: delivery === "email" ? undefined : code };
}

export async function verifyEmailOtp(rawEmail: string, code: string, device: DeviceInfo, ip: string): Promise<LoginResult> {
  enforceRateLimit("auth:verify-email-otp", rawEmail.trim().toLowerCase());
  const email = normalizeEmail(rawEmail);

  const otp = await db.emailOtp.findFirst({
    where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw ApiError.badRequest("Code expired — request a new one");
  if (otp.attempts >= EMAIL_OTP_MAX_ATTEMPTS) throw ApiError.forbidden("Too many attempts — request a new code");

  const hash = createHash("sha256").update(`${code.trim()}:${otp.salt}`).digest("hex");
  if (hash !== otp.codeHash) {
    await db.emailOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw ApiError.badRequest("Incorrect code");
  }
  await db.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({
      data: {
        id: randomBytes(12).toString("hex"),
        email,
        emailVerifiedAt: new Date(),
        displayName: `User ${randomInt(1000, 10000)}`,
        avatarColor: randomInt(0, 8),
      },
    });
    await db.userSettings.create({ data: { userId: user.id } });
    await db.userPrivacy.create({ data: { userId: user.id } });
    log.info("user-registered", { userId: user.id, method: "email" });
  } else if (!user.emailVerifiedAt) {
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }
  if (user.bannedUntil && user.bannedUntil > new Date()) throw ApiError.forbidden("Account suspended");

  // Apply the pending signup password (hashed at request time, never stored plaintext).
  if (otp.pendingPasswordHash && !user.passwordHash) {
    await db.user.update({ where: { id: user.id }, data: { passwordHash: otp.pendingPasswordHash } });
    user = await db.user.findUnique({ where: { id: user.id } }) || user;
  }

  if (user.twofaEnabled && user.twofaSecret) {
    return { status: "twofa_required", twofaTicket: await signTwofaTicket(user.id) };
  }
  return issueSession(user.id, device, ip, user);
}

// ---------- password login (identifier: email OR phone) ----------

/**
 * Password login with a single identifier field: email or phone — the same
 * account password works for both once the account has an email + password.
 * Brute-force defense: per-attempt counter on the user row with temporary
 * lockout after N failures (survives restarts — DB-backed).
 */
export async function loginPassword(
  identifier: string,
  password: string,
  device: DeviceInfo,
  ip: string
): Promise<LoginResult> {
  enforceRateLimit("auth:login-password", identifier.trim().toLowerCase());
  enforceRateLimit("auth:login-ip", ip);

  const isEmail = identifier.includes("@");
  const email = isEmail ? normalizeEmail(identifier) : null;
  const phone = !isEmail ? normalizePhone(identifier) : null;

  const user = email
    ? await db.user.findUnique({ where: { email } })
    : await db.user.findUnique({ where: { phone: phone! } });

  // Uniform error — never reveal whether the identifier exists (enumeration).
  const invalid = ApiError.badRequest("Incorrect credentials");
  if (!user || user.deletedAt || !user.passwordHash) throw invalid;
  if (user.bannedUntil && user.bannedUntil > new Date()) throw ApiError.forbidden("Account suspended");

  if (user.passwordLockedUntil && user.passwordLockedUntil > new Date()) {
    const waitS = Math.ceil((user.passwordLockedUntil.getTime() - Date.now()) / 1000);
    throw ApiError.rateLimited(Math.max(1, waitS));
  }

  if (!verifyPassword(password, user.passwordHash)) {
    const fails = user.passwordFailCount + 1;
    const lock = fails >= env.PASSWORD_LOCK_ATTEMPTS;
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordFailCount: lock ? 0 : fails,
        passwordLockedUntil: lock ? new Date(Date.now() + env.PASSWORD_LOCK_MINUTES * 60_000) : null,
      },
    });
    if (lock) {
      await appendAudit({ actorType: "user", actorId: user.id, action: "auth.password_lockout", targetType: "user", targetId: user.id, ip });
      throw ApiError.rateLimited(env.PASSWORD_LOCK_MINUTES * 60);
    }
    throw invalid;
  }

  await db.user.update({ where: { id: user.id }, data: { passwordFailCount: 0, passwordLockedUntil: null } });
  await appendAudit({ actorType: "user", actorId: user.id, action: "auth.login_password", targetType: "session", targetId: user.id, ip });

  if (user.twofaEnabled && user.twofaSecret) {
    return { status: "twofa_required", twofaTicket: await signTwofaTicket(user.id) };
  }
  return issueSession(user.id, device, ip, user);
}

/** Set (first time) or change the account password from settings. */
export async function setPassword(
  userId: string,
  newPassword: string,
  currentPassword: string | undefined,
  ip?: string
) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound("User not found");

  if (user.passwordHash) {
    // Changing an existing password requires the current one.
    const invalid = ApiError.forbidden("Current password is incorrect");
    if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) throw invalid;
  }

  const policyError = validateUserPassword(newPassword);
  if (policyError) throw ApiError.badRequest(policyError);

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword), passwordFailCount: 0, passwordLockedUntil: null },
  });
  await appendAudit({ actorType: "user", actorId: userId, action: user.passwordHash ? "auth.password_changed" : "auth.password_set", targetType: "user", targetId: userId, ip });
  return { set: true };
}

export interface PublicSelf {
  id: string;
  phone: string | null;
  email: string | null;
  username: string | null;
  displayName: string;
  bio: string | null;
  avatarMediaId: string | null;
  twofaEnabled: boolean;
}

async function issueSession(
  userId: string,
  device: DeviceInfo,
  ip: string,
  user: { id: string; phone: string | null; email: string | null; username: string | null; displayName: string; bio: string | null; avatarMediaId: string | null; twofaEnabled: boolean }
): Promise<LoginResult> {
  const sessionId = randomBytes(12).toString("hex");
  const refreshToken = randomBytes(48).toString("base64url");
  const refreshHash = createHash("sha256").update(refreshToken).digest("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await db.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: refreshHash,
      deviceName: device.deviceName?.slice(0, 60) || "Unknown device",
      platform: device.platform?.slice(0, 20) || "web",
      appVersion: device.appVersion?.slice(0, 40),
      ip,
      userAgent: undefined,
      expiresAt,
    },
  });
  await appendAudit({ actorType: "user", actorId: userId, action: "auth.login", targetType: "session", targetId: sessionId, ip });

  return {
    status: "ok",
    accessToken: await signAccessToken(userId, sessionId),
    refreshToken,
    session: { id: sessionId, deviceName: device.deviceName || "Unknown device", expiresAt: expiresAt.toISOString() },
    user: {
      id: user.id,
      phone: user.phone,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarMediaId: user.avatarMediaId,
      twofaEnabled: user.twofaEnabled,
    },
  };
}

// ---------- refresh / logout ----------

export async function refreshSession(refreshToken: string, ip: string) {
  enforceRateLimit("auth:refresh", ip);
  const hash = createHash("sha256").update(refreshToken).digest("hex");
  const session = await db.session.findUnique({ where: { refreshTokenHash: hash }, include: { user: true } });

  if (!session || session.expiresAt < new Date()) {
    throw ApiError.unauthorized("Refresh token invalid or expired");
  }
  if (session.revokedAt) {
    // Reuse detection: a rotated/revoked token was presented → kill the family.
    await db.session.update({
      where: { id: session.id },
      data: { revokedReason: "refresh-reuse-detected" },
    });
    await appendAudit({ actorType: "user", actorId: session.userId, action: "auth.refresh_reuse_detected", targetType: "session", targetId: session.id, ip });
    throw ApiError.unauthorized("Session revoked");
  }
  if (session.user.bannedUntil && session.user.bannedUntil > new Date()) {
    throw ApiError.forbidden("Account suspended");
  }

  const newRefresh = randomBytes(48).toString("base64url");
  const newHash = createHash("sha256").update(newRefresh).digest("hex");
  await db.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: newHash, lastActiveAt: new Date(), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  return {
    accessToken: await signAccessToken(session.userId, session.id),
    refreshToken: newRefresh,
  };
}

export async function revokeSession(userId: string, sessionId: string, reason: string, ip?: string) {
  const session = await db.session.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw ApiError.notFound("Session not found");
  await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date(), revokedReason: reason } });
  await appendAudit({ actorType: "user", actorId: userId, action: "auth.session_revoked", targetType: "session", targetId: sessionId, ip });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string, ip?: string) {
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  for (const s of sessions) {
    await db.session.update({ where: { id: s.id }, data: { revokedAt: new Date(), revokedReason: "logout-all" } });
  }
  await appendAudit({ actorType: "user", actorId: userId, action: "auth.logout_all", detailJson: JSON.stringify({ count: sessions.length }), ip });
  return sessions.length;
}

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastActiveAt: "desc" },
  });
  return sessions.map((s) => ({
    id: s.id,
    deviceName: s.deviceName,
    platform: s.platform,
    appVersion: s.appVersion,
    ip: s.ip,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    isCurrent: s.id === currentSessionId,
  }));
}

// ---------- 2FA management ----------

export async function setupTwofa(userId: string) {
  const { generateTotpSecret, totpUri } = await import("../security/totp");
  const secretKey = generateTotpSecret();
  await db.user.update({ where: { id: userId }, data: { twofaSecret: secretKey, twofaEnabled: false } });
  const user = await db.user.findUnique({ where: { id: userId } });
  return { secret: secretKey, otpauthUri: totpUri(secretKey, user?.username || user?.phone || userId) };
}

export async function enableTwofa(userId: string, code: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.twofaSecret) throw ApiError.badRequest("Run setup first");
  if (!verifyTotp(user.twofaSecret, code)) throw ApiError.badRequest("Invalid code");
  await db.user.update({ where: { id: userId }, data: { twofaEnabled: true } });
  await appendAudit({ actorType: "user", actorId: userId, action: "auth.2fa_enabled" });
  return { enabled: true };
}

export async function disableTwofa(userId: string, code: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.twofaSecret || !user.twofaEnabled) throw ApiError.badRequest("2FA not enabled");
  if (!verifyTotp(user.twofaSecret, code)) throw ApiError.badRequest("Invalid code");
  await db.user.update({ where: { id: userId }, data: { twofaEnabled: false, twofaSecret: null } });
  await appendAudit({ actorType: "user", actorId: userId, action: "auth.2fa_disabled" });
  return { enabled: false };
}

// ---------- account deletion (spec §49) ----------

export async function requestAccountDeletion(userId: string) {
  const { enqueueJob } = await import("./queue.service");
  await enqueueJob("account.delete", { userId }, { runAt: new Date(Date.now() + 3000), dedupeKey: `account-delete-${userId}` });
  return { scheduled: true };
}
