// ============================================================
// Email provider layer (spec §15 extended) — real signup/login mail.
//
// Resolution order (auto):
//   1. smtp    — SMTP_HOST + SMTP_USER + SMTP_PASS set (works with any
//                provider offering SMTP: Brevo, SendGrid, Mailgun, Gmail
//                app-password, Outlook, self-hosted Postfix…)
//   2. console — dev fallback (full message to the server log)
//   3. none    — production with zero config → requestEmailOtp rejects
//                with a clear error instead of silently dropping mail.
//
// Deliverability note: with SMTP configured, mail is sent for real.
// SPF/DKIM/DMARC alignment depends on the sending domain — see
// .env.example for provider setup hints.
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
  readonly name: "smtp" | "console" | "none";
  send(msg: EmailMessage): Promise<void>;
}

/** Dev fallback: logs the full message (dev only — visibility is the point). */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;
  async send(msg: EmailMessage) {
    log.info("email-console", { to: msg.to, subject: msg.subject, text: msg.text });
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
      await t.sendMail({ from: this.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
    } catch (e) {
      // Never echo SMTP error bodies (may contain credentials/account info)
      log.error("email-smtp-error", { error: (e as Error).message.slice(0, 200) });
      this.transporter = null; // force transport re-init next attempt
      throw ApiError.unavailable("Email delivery failed — try again shortly");
    }
  }
}

class NoEmailProvider implements EmailProvider {
  readonly name = "none" as const;
  async send() {
    throw ApiError.unavailable(
      "Email delivery is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS (see .env.example)"
    );
  }
}

function buildProvider(): EmailProvider {
  const ready = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  if (ready) return new SmtpEmailProvider(env.SMTP_HOST, env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM);
  if (env.NODE_ENV !== "production") return new ConsoleEmailProvider();
  return new NoEmailProvider();
}

const globalForEmail = globalThis as unknown as { __emailProvider?: EmailProvider };

/** Active provider (process-lifetime singleton; re-evaluates per boot). */
export function getEmailProvider(): EmailProvider {
  if (!globalForEmail.__emailProvider) globalForEmail.__emailProvider = buildProvider();
  return globalForEmail.__emailProvider;
}

/** A provider that actually delivers mail (smtp) — vs console/none. */
export function hasRealEmailProvider(): boolean {
  return getEmailProvider().name === "smtp";
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
