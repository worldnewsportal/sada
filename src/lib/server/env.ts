// Environment & secrets management (spec §45, §28: never hardcode secrets).
// All secrets come from env; dev secrets are auto-generated once and persisted
// to .env so they survive restarts but are never committed.
import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const ROOT = process.env.PROJECT_ROOT || "/home/z/my-project";

function ensureEnvKey(key: string, bytes = 48): string {
  if (process.env[key]) return process.env[key]!;
  // try reading .env file directly (Next inlines some vars)
  const envPath = join(ROOT, ".env");
  try {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      const m = content.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (m) return m[1].trim();
    }
  } catch {
    /* ignore */
  }
  const value = randomBytes(bytes).toString("base64url");
  try {
    appendFileSync(envPath, `\n${key}=${value}\n`);
  } catch {
    /* read-only fs — fall back to ephemeral (still random per boot) */
  }
  process.env[key] = value;
  return value;
}

export const env = {
  get JWT_SECRET() {
    return ensureEnvKey("JWT_SECRET");
  },
  get INTERNAL_SECRET() {
    // HMAC secret between API <-> realtime <-> worker (internal emit endpoint)
    return ensureEnvKey("INTERNAL_SECRET");
  },
  get APP_PEPPER() {
    return ensureEnvKey("APP_PEPPER", 32);
  },
  get MEDIA_ROOT() {
    return process.env.MEDIA_ROOT || join(ROOT, "data", "media");
  },
  get UPLOAD_ROOT() {
    return process.env.UPLOAD_ROOT || join(ROOT, "data", "uploads");
  },
  get CDN_BASE_URL() {
    // Empty in dev: media served through /api/v1/media/file (signed).
    // In production, set to https://cdn.example.com (spec §8).
    return process.env.CDN_BASE_URL || "";
  },
  get VAPID_PUBLIC_KEY() {
    return process.env.VAPID_PUBLIC_KEY || "";
  },
  get VAPID_PRIVATE_KEY() {
    return process.env.VAPID_PRIVATE_KEY || "";
  },
  get VAPID_SUBJECT() {
    return process.env.VAPID_SUBJECT || "mailto:admin@sada.local";
  },
  get FCM_CREDENTIALS_JSON() {
    return process.env.FCM_CREDENTIALS_JSON || "";
  },
  get APNS_KEY_ID() {
    return process.env.APNS_KEY_ID || "";
  },
  get EVENT_RETENTION_DAYS() {
    return parseInt(process.env.EVENT_RETENTION_DAYS || "7", 10);
  },
  get NODE_ENV() {
    return process.env.NODE_ENV || "development";
  },
  get STORAGE_DRIVER() {
    // "local" (dev, signed URLs via API) | "s3" (production, MinIO/S3 presigned)
    return process.env.STORAGE_DRIVER || "local";
  },
  get S3_ENDPOINT() {
    return process.env.OBJECT_STORAGE_ENDPOINT || "";
  },
  get S3_BUCKET() {
    return process.env.OBJECT_STORAGE_BUCKET || "sada-media";
  },
  get S3_ACCESS_KEY() {
    return process.env.OBJECT_STORAGE_ACCESS_KEY || "";
  },
  get S3_SECRET_KEY() {
    return process.env.OBJECT_STORAGE_SECRET_KEY || "";
  },
  get S3_REGION() {
    return process.env.OBJECT_STORAGE_REGION || "us-east-1";
  },
  get REALTIME_URL() {
    // internal emit endpoint of the realtime service
    return process.env.REALTIME_URL || "http://127.0.0.1:3003";
  },
  get OTP_DEV_ECHO() {
    // Dev-only: return OTP in response so the flow is testable without an SMS
    // provider. Automatically disabled when NODE_ENV=production. Production
    // uses the pluggable SmsProvider (Twilio-compatible HTTP gateway).
    return process.env.OTP_DEV_ECHO !== "false" && this.NODE_ENV !== "production";
  },
};
