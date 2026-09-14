// ============================================================
// Email provider layer (spec §15 extended) — real signup/login mail.
//
// Resolution order (auto — first configured wins):
//   1. resend  — RESEND_API_KEY set (HTTPS API, no SMTP setup)
//   2. brevo   — BREVO_API_KEY set (HTTPS API, no SMTP setup)
//   3. smtp    — SMTP_HOST + SMTP_USER + SMTP_PASS set (works with any
//                provider offering SMTP: Brevo, SendGrid, Mailgun, Gmail
//                app-password, Outlook, self-hosted Postfix…)
//   4. console — dev fallback (full message to the server log)
//   5. none    — production with zero config → requestEmailOtp rejects
//                with a clear bilingual error instead of silently
//                dropping mail.
//
// Deliverability note: with any provider configured, mail is sent FOR REAL.
// SPF/DKIM/DMARC alignment depends on the sending domain — API providers
// (Resend/Brevo) walk you through it in their dashboard. See .env.example.
// ============================================================
import { ApiError } from "../errors";
import { log } from "../logger";
import { env } from "../env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: "resend" | "brevo" | "smtp" | "console" | "none";
  /** Resolves when the provider accepted the message. SMTP returns the
   *  nodemailer SentMessageInfo (diagnostics/self-test); others return void. */
  send(msg: EmailMessage): Promise<unknown>;
}

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "إرسال البريد غير مُهيأ بعد — يحتاج الخادم بيانات مزوّد بريد حقيقي (خطوة واحدة، انظر EMAIL_SETUP) — " +
  "Email delivery is not configured — set RESEND_API_KEY / BREVO_API_KEY / SMTP_HOST+SMTP_USER+SMTP_PASS (see .env.example)";

/** Dev fallback: logs the full message (dev only — visibility is the point). */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;
  async send(msg: EmailMessage) {
    log.info("email-console", { to: msg.to, subject: msg.subject, text: msg.text });
  }
}

function friendlySendError(provider: string, e: unknown): never {
  // Never echo provider error bodies (may contain keys/account info)
  const raw = (e as Error)?.message || "unknown";
  log.error("email-send-error", { provider, error: raw.slice(0, 200) });
  throw ApiError.unavailable("تعذّر إرسال البريد — أعد المحاولة بعد قليل — Email delivery failed — try again shortly");
}

/** Resend (https://resend.com) — simple HTTPS API, generous free tier. */
class ResendApiProvider implements EmailProvider {
  readonly name = "resend" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async send(msg: EmailMessage) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      friendlySendError("resend", e);
    }
  }
}

/** Brevo (https://brevo.com, ex-Sendinblue) — HTTPS API, 300 mails/day free. */
class BrevoApiProvider implements EmailProvider {
  readonly name = "brevo" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async send(msg: EmailMessage) {
    // "Display Name <addr@x>" → { name, email }
    const m = this.from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    const sender = m ? { name: m[1], email: m[2] } : { email: this.from };
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": this.apiKey, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender,
          to: [{ email: msg.to }],
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`brevo HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      friendlySendError("brevo", e);
    }
  }
}

/** Real email via SMTP (nodemailer — the universal transport). */
class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp" as const;
  private transporter: import("nodemailer").Transporter | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly secure: boolean,
    private readonly user: string,
    private readonly pass: string,
    private readonly from: string
  ) {}

  /** Gmail rewrites mismatched From headers; use the authenticated address
   *  when the configured From is still the placeholder local domain. */
  private get effectiveFrom(): string {
    if (/@(sada\.local|yourdomain\.com)>?\s*$/i.test(this.from) && this.user.includes("@")) return this.user;
    return this.from;
  }

  private async getTransporter() {
    if (!this.transporter) {
      const nodemailer = await import("nodemailer");
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth: { user: this.user, pass: this.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
    return this.transporter;
  }

  async send(msg: EmailMessage) {
    try {
      const t = await this.getTransporter();
      const from = this.effectiveFrom;
      // Returned for diagnostics (self-test CLI uses it for the preview URL)
      return await t.sendMail({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
    } catch (e) {
      // Never echo SMTP error bodies (may contain credentials/account info)
      log.error("email-smtp-error", { error: (e as Error).message.slice(0, 200) });
      this.transporter = null; // force transport re-init next attempt
      throw ApiError.unavailable("تعذّر إرسال البريد — أعد المحاولة بعد قليل — Email delivery failed — try again shortly");
    }
  }
}

class NoEmailProvider implements EmailProvider {
  readonly name = "none" as const;
  async send() {
    throw ApiError.unavailable(EMAIL_NOT_CONFIGURED_MESSAGE);
  }
}

export interface EmailConfigStatus {
  provider: EmailProvider["name"];
  real: boolean;
  hint: string;
}

/** Which provider WOULD be used right now (no side effects) — used by the
 *  self-test CLI and boot logging. Order mirrors buildProvider(). */
export function resolveEmailProviderName(): EmailConfigStatus {
  if (env.RESEND_API_KEY) return { provider: "resend", real: true, hint: "RESEND_API_KEY" };
  if (env.BREVO_API_KEY) return { provider: "brevo", real: true, hint: "BREVO_API_KEY" };
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS)
    return { provider: "smtp", real: true, hint: `${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.SMTP_USER}` };
  if (env.NODE_ENV !== "production") return { provider: "console", real: false, hint: "dev echo (no real mail)" };
  return { provider: "none", real: false, hint: "NOT CONFIGURED — emails will be rejected" };
}

function buildProvider(): EmailProvider {
  const status = resolveEmailProviderName();
  switch (status.provider) {
    case "resend":
      return new ResendApiProvider(env.RESEND_API_KEY, env.EMAIL_FROM);
    case "brevo":
      return new BrevoApiProvider(env.BREVO_API_KEY, env.EMAIL_FROM);
    case "smtp":
      return new SmtpEmailProvider(env.SMTP_HOST, env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM);
    case "console":
      return new ConsoleEmailProvider();
    case "none":
      log.warn("email-provider-missing", {
        hint: "Set RESEND_API_KEY or BREVO_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS — see .env.example §EMAIL",
      });
      return new NoEmailProvider();
  }
}

const globalForEmail = globalThis as unknown as { __emailProvider?: EmailProvider };

/** Active provider (process-lifetime singleton; re-evaluates per boot). */
export function getEmailProvider(): EmailProvider {
  if (!globalForEmail.__emailProvider) globalForEmail.__emailProvider = buildProvider();
  return globalForEmail.__emailProvider;
}

/** A provider that actually delivers mail — vs console/none. */
export function hasRealEmailProvider(): boolean {
  return getEmailProvider().name !== "console" && getEmailProvider().name !== "none";
}

// ---------- templates (bilingual: Arabic RTL + English) ----------

const BRAND_TEAL = "#0d9488";

export function renderEmailOtp(opts: { code: string; ttlMin: number; isNew: boolean }): { subject: string; html: string; text: string } {
  const { code, ttlMin, isNew } = opts;
  const titleAr = isNew ? "أهلاً بك في صدى!" : "تسجيل الدخول إلى صدى";
  const bodyAr = isNew
    ? "نشكر لك انضمامك إلى صدى — رسائل آمنة وسريعة. استخدم الرمز التالي لتفعيل حسابك:"
    : "استخدم الرمز التالي لتسجيل الدخول إلى حسابك:";
  const titleEn = isNew ? "Welcome to Sada!" : "Sign in to Sada";
  const bodyEn = isNew
    ? "Thanks for joining Sada — secure, fast messaging. Use this code to activate your account:"
    : "Use this code to sign in to your account:";

  const subject = isNew ? `رمز تفعيل صدى — Sada activation code: ${code}` : `رمز الدخول — Sada sign-in code: ${code}`;

  const html = `<!doctype html>
<html lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f0fdfa;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ccfbf1;">
    <div style="background:linear-gradient(135deg,${BRAND_TEAL},#115e59);padding:28px 24px;text-align:center;">
      <div style="font-size:30px;font-weight:800;color:#ffffff;">صدى <span style="font-weight:400;font-size:18px;opacity:.85;">Sada</span></div>
      <div style="color:#99f6e4;font-size:14px;margin-top:4px;">رسائل فورية آمنة</div>
    </div>
    <div style="padding:28px 24px;" dir="rtl">
      <h1 style="margin:0 0 10px;font-size:20px;color:#134e4a;">${titleAr}</h1>
      <p style="margin:0 0 18px;color:#334155;font-size:15px;line-height:1.7;">${bodyAr}</p>
      <div style="text-align:center;background:#f0fdfa;border:2px dashed ${BRAND_TEAL};border-radius:12px;padding:16px;margin-bottom:18px;">
        <span style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0f766e;direction:ltr;unicode-bidi:embed;">${code}</span>
      </div>
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.7;">هذا الرمز صالح لمدة ${ttlMin} دقائق. إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة — حسابك في أمان.</p>
    </div>
    <div style="padding:0 24px 28px;" dir="ltr">
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px;">
      <h2 style="margin:0 0 8px;font-size:16px;color:#134e4a;">${titleEn}</h2>
      <p style="margin:0 0 14px;color:#334155;font-size:14px;line-height:1.6;">${bodyEn}</p>
      <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;">Code: <b style="letter-spacing:3px;color:#0f766e;">${code}</b> — valid for ${ttlMin} minutes. Didn't request it? Ignore this email.</p>
    </div>
  </div>
  <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px;">© ${new Date().getFullYear()} Sada · صدى</p>
</body></html>`;

  const text = `${titleAr}\n${bodyAr}\n\n${code}\n\n(صالح ${ttlMin} دقائق)\n---\n${titleEn}\n${bodyEn}\n\n${code}\n\n(valid ${ttlMin} minutes)`;

  return { subject, html, text };
}
