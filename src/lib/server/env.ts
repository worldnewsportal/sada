// Environment & secrets management (spec §45, §28: never hardcode secrets).
// All secrets come from env; dev secrets are auto-generated once and persisted
// to .env so they survive restarts but are never committed.
import { existsSync, readFileSync, appendFileSync, statSync } from "fs";
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

/** Read a simple KEY=value from the project .env file (mtime-checked cache,
 *  quote-stripped). Process env always wins — this is only the fallback for
 *  deployments where the shell environment does not carry the var (e.g.
 *  standalone server). Editing .env takes effect on the NEXT read — no
 *  restart needed (the file is re-parsed when its mtime changes). */
const __envFileCache: { mtimeMs: number; map: Map<string, string> } = { mtimeMs: -1, map: new Map() };

function loadEnvFile() {
  try {
    const envPath = join(ROOT, ".env");
    const mtime = statSync(envPath).mtimeMs;
    if (mtime === __envFileCache.mtimeMs) return;
    __envFileCache.mtimeMs = mtime;
    __envFileCache.map = new Map();
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        __envFileCache.map.set(m[1], v);
      }
    }
  } catch {
    /* unreadable/missing file — process env only */
    __envFileCache.mtimeMs = -1;
    __envFileCache.map = new Map();
  }
}

function envFileGet(key: string): string {
  if (process.env[key]) return process.env[key]!;
  loadEnvFile();
  return __envFileCache.map.get(key) || "";
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
  get SMS_PROVIDER() {
    // "auto" (default) | "twilio" | "http" | "console" | "none"
    return process.env.SMS_PROVIDER || "auto";
  },
  get TWILIO_ACCOUNT_SID() {
    return process.env.TWILIO_ACCOUNT_SID || "";
  },
  get TWILIO_AUTH_TOKEN() {
    return process.env.TWILIO_AUTH_TOKEN || "";
  },
  get TWILIO_FROM() {
    return process.env.TWILIO_FROM || "";
  },
  get TEST_PHONE_PREFIXES() {
    // Numbers starting with any of these prefixes are FAKE/test numbers:
    // no real SMS is ever sent, the code is surfaced in-app (dev/demo only).
    // "+999" is not an assigned country code → collision-free by design.
    const raw = process.env.TEST_PHONE_PREFIXES;
    return (raw === undefined ? "+999" : raw)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  },
  get ALLOW_TEST_PHONES() {
    // Test phones are a development/demo affordance. They stay enabled in
    // non-production and require an explicit opt-in in production.
    if (this.NODE_ENV !== "production") return true;
    return process.env.ALLOW_TEST_PHONES === "true";
  },
  get SMS_RESEND_COOLDOWN_S() {
    // Minimum seconds between two OTP sends for the same phone (anti-SMS-
    // bombing / cost control). Verify attempt cap + TTL remain independent.
    return parseInt(process.env.SMS_RESEND_COOLDOWN_S || "45", 10);
  },
  get SMS_MAX_PER_HOUR() {
    // Hourly per-phone ceiling on issued OTP codes (belt & braces on top of
    // the sliding-window limiter; survives limiter restarts since it counts DB rows).
    return parseInt(process.env.SMS_MAX_PER_HOUR || "10", 10);
  },
  // ---------- EMAIL (signup / login / welcome) ----------
  // Email provider env vars support a .env-file fallback (same pattern as
  // ensureEnvKey): the deployed standalone server may not inherit the shell
  // environment, but it CAN read the project .env file at runtime.
  get SMTP_HOST() {
    return envFileGet("SMTP_HOST") || "";
  },
  get SMTP_PORT() {
    return parseInt(envFileGet("SMTP_PORT") || "587", 10);
  },
  get SMTP_USER() {
    return envFileGet("SMTP_USER") || "";
  },
  get SMTP_PASS() {
    return envFileGet("SMTP_PASS") || "";
  },
  get SMTP_SECURE() {
    // Auto: 465 → implicit TLS, otherwise STARTTLS (unless explicitly set).
    const raw = envFileGet("SMTP_SECURE");
    return raw ? raw === "true" : this.SMTP_PORT === 465;
  },
  get RESEND_API_KEY() {
    return envFileGet("RESEND_API_KEY") || "";
  },
  get BREVO_API_KEY() {
    return envFileGet("BREVO_API_KEY") || "";
  },
  get EMAIL_FROM() {
    return envFileGet("EMAIL_FROM") || "Sada \u0635\u062f\u0649 <no-reply@sada.local>";
  },
  get EMAIL_RESEND_COOLDOWN_S() {
    // Email is slower than SMS and costs little — but cooldown still stops
    // mailbox-bombing and code-injection spam.
    return parseInt(process.env.EMAIL_RESEND_COOLDOWN_S || "60", 10);
  },
  get EMAIL_MAX_PER_HOUR() {
    return parseInt(process.env.EMAIL_MAX_PER_HOUR || "10", 10);
  },
  get PASSWORD_LOCK_ATTEMPTS() {
    // Failed password logins before temporary lockout (brute-force defense).
    return parseInt(process.env.PASSWORD_LOCK_ATTEMPTS || "5", 10);
  },
  get PASSWORD_LOCK_MINUTES() {
    return parseInt(process.env.PASSWORD_LOCK_MINUTES || "15", 10);
  },
};
