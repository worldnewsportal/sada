// ============================================================
// Email provider layer (spec §15 extended) — real signup/login mail
// with automatic FAILOVER: every configured provider is tried in
// order until one accepts the message (user asked for "كل الطرق
// كاحتياط اذا تعطل واحد").
//
// Chain order (first configured wins the lead, rest are backups):
//   1. resend  — RESEND_API_KEY (HTTPS API)
//   2. brevo   — BREVO_API_KEY  (HTTPS API)
//   3. smtp    — SMTP_HOST + SMTP_USER + SMTP_PASS (nodemailer)
//   fallback:  console (dev echo) | none (production hard-fail)
//
// Live config: .env edits apply on the NEXT request (mtime-checked
// env reads + chain-based provider rebuild) — no restart needed.
//
// Deliverability note: Resend/Brevo test mode only delivers to the
// account owner's address until a domain is verified — the error
// mapping below says exactly that, bilingually, without leaking keys.
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

export type EmailProviderName = "resend" | "brevo" | "smtp" | "failover" | "console" | "none";

export interface EmailProvider {
  readonly name: EmailProviderName;
  /** Resolves when a provider ACCEPTED the message. SMTP returns the
   *  nodemailer SentMessageInfo (diagnostics/self-test); others return void. */
  send(msg: EmailMessage): Promise<unknown>;
}

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "إرسال البريد غير مُهيأ بعد — أضف RESEND_API_KEY أو BREVO_API_KEY أو SMTP_HOST/SMTP_USER/SMTP_PASS في .env — " +
  "Email delivery is not configured — set RESEND_API_KEY / BREVO_API_KEY / SMTP_HOST+SMTP_USER+SMTP_PASS (see .env.example)";

/** Bilingual, key-free explanations for API-provider rejections. */
export function describeResendError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 || b.includes("api key")) {
    return "مفتاح Resend غير صالح — تحقق من RESEND_API_KEY — Invalid Resend API key";
  }
  if (b.includes("testing emails") || b.includes("own email address")) {
    return (
      "وضع الاختبار في Resend يسمح مؤقتاً بإرسال البريد إلى بريد صاحب الحساب فقط — " +
      "لإرسال البريد إلى أي عنوان: أضف ونطّق نطاقك في resend.com/domains (مجاني)، أو فعّل Gmail SMTP كطريقة أساسية — " +
      "Resend test mode delivers to the account-owner address only until a domain is verified"
    );
  }
  if (b.includes("from") && (b.includes("verify") || b.includes("match"))) {
    return (
      "عنوان المرسِم غير مسموح في Resend — استخدم onboarding@resend.dev أو ونطّق نطاقك — " +
      "Resend rejected the From address — use onboarding@resend.dev or verify your domain"
    );
  }
  return "تعذّر إرسال البريد — أعد المحاولة بعد قليل — Email delivery failed — try again shortly";
}

export function describeBrevoError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 || status === 403 || b.includes("api key") || b.includes("unauthorized")) {
    return "مفتاح Brevo غير صالح أو ناقص الصلاحيات — تحقق من BREVO_API_KEY — Invalid/unauthorized Brevo API key";
  }
  return "تعذّر إرسال البريد — أعد المحاولة بعد قليل — Email delivery failed — try again shortly";
}

/** Dev fallback: logs the full message (dev only — visibility is the point). */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;
  async send(msg: EmailMessage) {
    log.info("email-console", { to: msg.to, subject: msg.subject, text: msg.text });
  }
}

/** HTTPS-API base: shared fetch + safe error mapping. */
abstract class HttpApiProvider implements EmailProvider {
  abstract readonly name: EmailProviderName;
  constructor(
    protected readonly endpoint: string,
    protected readonly headers: Record<string, string>,
    protected readonly from: string
  ) {}

  protected abstract payload(msg: EmailMessage): unknown;
  protected abstract describe(status: number, body: string): string;

  async send(msg: EmailMessage) {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify(this.payload(msg)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      log.error("email-api-error", { provider: this.name, error: (e as Error).message.slice(0, 200) });
      throw ApiError.unavailable("تعذّر إرسال البريد — أعد المحاولة بعد قليل — Email delivery failed — try again shortly");
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      log.error("email-api-error", { provider: this.name, status: res.status, body });
      throw ApiError.unavailable(this.describe(res.status, body));
    }
  }
}

class ResendApiProvider extends HttpApiProvider {
  readonly name = "resend" as const;
  constructor(apiKey: string, from: string) {
    super("https://api.resend.com/emails", { Authorization: `Bearer ${apiKey}` }, from);
  }
  protected payload(msg: EmailMessage) {
    return { from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text };
  }
  protected describe(status: number, body: string) {
    return describeResendError(status, body);
  }
}

class BrevoApiProvider extends HttpApiProvider {
  readonly name = "brevo" as const;
  constructor(apiKey: string, from: string) {
    super("https://api.brevo.com/v3/smtp/email", { "api-key": apiKey, accept: "application/json" }, from);
  }
  /** "Display Name <addr@x>" → { name, email } */
  protected payload(msg: EmailMessage) {
    const m = this.from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    const sender = m ? { name: m[1], email: m[2] } : { email: this.from };
    return { sender, to: [{ email: msg.to }], subject: msg.subject, htmlContent: msg.html, textContent: msg.text };
  }
  protected describe(status: number, body: string) {
    return describeBrevoError(status, body);
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
   *  when the configured From is a placeholder sandbox domain. */
  private get effectiveFrom(): string {
    if (/@(sada\.local|yourdomain\.com|resend\.dev)>?\s*$/i.test(this.from) && this.user.includes("@")) return this.user;
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

/**
 * Tries each configured provider in order until one ACCEPTS the message.
 * A provider failure (bad key, sandbox restriction, network) logs a warning
 * and falls through to the next — the chain's whole point is resilience.
 */
export class FailoverEmailProvider implements EmailProvider {
  readonly name = "failover" as const;
  constructor(private readonly children: EmailProvider[]) {}

  async send(msg: EmailMessage) {
    let lastError: unknown;
    for (const child of this.children) {
      try {
        return await child.send(msg);
      } catch (e) {
        lastError = e;
        log.warn("email-failover", { from: child.name, remaining: this.children.length - this.children.indexOf(child) - 1 });
      }
    }
    throw lastError;
  }
}

export interface EmailConfigStatus {
  provider: EmailProviderName;
  real: boolean;
  hint: string;
  /** Full ordered chain of configured REAL providers (failover order). */
  chain: string[];
}

/** Which providers are configured right now, in failover order (pure —
 *  no side effects; reads env each call so .env edits apply live). */
export function configuredEmailChain(): string[] {
  const chain: string[] = [];
  if (env.RESEND_API_KEY) chain.push("resend");
  if (env.BREVO_API_KEY) chain.push("brevo");
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) chain.push("smtp");
  return chain;
}

export function resolveEmailProviderName(): EmailConfigStatus {
  const chain = configuredEmailChain();
  if (chain.length > 0) {
    const hint =
      chain.length === 1
        ? chain[0] === "smtp"
          ? `${env.SMTP_HOST}:${env.SMTP_PORT} as ${env.SMTP_USER}`
          : chain[0]
        : chain.join(" → ") + " (failover)";
    return { provider: (chain.length === 1 ? chain[0] : "failover") as EmailProviderName, real: true, hint, chain };
  }
  if (env.NODE_ENV !== "production") return { provider: "console", real: false, hint: "dev echo (no real mail)", chain };
  return { provider: "none", real: false, hint: "NOT CONFIGURED — emails will be rejected", chain };
}

function buildProvider(): EmailProvider {
  const chain = configuredEmailChain();
  const instances: EmailProvider[] = [];
  for (const name of chain) {
    if (name === "resend") instances.push(new ResendApiProvider(env.RESEND_API_KEY, env.EMAIL_FROM));
    else if (name === "brevo") instances.push(new BrevoApiProvider(env.BREVO_API_KEY, env.EMAIL_FROM));
    else if (name === "smtp")
      instances.push(new SmtpEmailProvider(env.SMTP_HOST, env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM));
  }
  if (instances.length === 0) {
    if (env.NODE_ENV !== "production") return new ConsoleEmailProvider();
    log.warn("email-provider-missing", {
      hint: "Set RESEND_API_KEY or BREVO_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS — see .env.example §EMAIL",
    });
    return new NoEmailProvider();
  }
  if (instances.length === 1) return instances[0];
  return new FailoverEmailProvider(instances);
}

const globalForEmail = globalThis as unknown as { __emailProvider?: EmailProvider; __emailChainKey?: string };

/** Active provider (process-lifetime, auto-rebuilt when the configured
 *  chain changes — adding/removing keys in .env applies immediately). */
export function getEmailProvider(): EmailProvider {
  const chainKey = configuredEmailChain().join(",");
  if (!globalForEmail.__emailProvider || globalForEmail.__emailChainKey !== chainKey) {
    globalForEmail.__emailProvider = buildProvider();
    globalForEmail.__emailChainKey = chainKey;
  }
  return globalForEmail.__emailProvider;
}

/** A provider that actually delivers mail — vs console/none. */
export function hasRealEmailProvider(): boolean {
  return configuredEmailChain().length > 0;
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
