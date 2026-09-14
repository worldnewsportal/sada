// ============================================================
// SMS provider layer (spec §15) — real-number OTP delivery.
//
// Resolution order (SMS_PROVIDER=auto):
//   1. twilio  — TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM set
//   2. http    — SMS_GATEWAY_URL set (any generic POST {to,text} gateway)
//   3. console — dev fallback (code goes to the server log)
//   4. none    — production with zero config → requestOtp rejects with a
//                clear error instead of silently dropping codes.
//
// Test numbers (prefix "+999" by default, TEST_PHONE_PREFIXES) NEVER hit a
// provider: they exist solely for instant demo/testing, are disabled in
// production unless ALLOW_TEST_PHONES=true, and their code is surfaced in-app
// only when OTP_DEV_ECHO is active (auto-off in production).
// ============================================================
import { ApiError } from "../errors";
import { log } from "../logger";
import { env } from "../env";

export interface SmsProvider {
  readonly name: "twilio" | "http" | "console" | "none";
  send(phone: string, text: string): Promise<void>;
}

/** Dev fallback: logs the full code to the server console (dev only). */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console" as const;
  async send(phone: string, text: string) {
    // dev-only provider — full visibility is the point here
    log.info("sms-console", { phone, text });
  }
}

/** Real SMS via Twilio REST API (Messages resource, basic auth, form-encoded). */
class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio" as const;
  constructor(
    private readonly sid: string,
    private readonly token: string,
    private readonly from: string
  ) {}

  async send(phone: string, text: string) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: this.from, Body: text }).toString(),
        // OTP messages are time-critical — don't hang the login flow
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.error("sms-twilio-network-error", { error: (e as Error).message });
      throw ApiError.unavailable("SMS delivery failed — try again shortly");
    }
    if (!res.ok) {
      // Never echo Twilio error bodies (may contain account details)
      log.error("sms-twilio-error", { status: res.status });
      throw ApiError.unavailable(
        res.status === 401 ? "SMS provider credentials rejected" : "SMS delivery failed — try again shortly"
      );
    }
  }
}

/** Real SMS via any generic HTTP gateway: POST {to, text} + bearer token. */
class HttpSmsProvider implements SmsProvider {
  readonly name = "http" as const;
  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  async send(phone: string, text: string) {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ to: phone, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      log.error("sms-http-network-error", { error: (e as Error).message });
      throw ApiError.unavailable("SMS delivery failed — try again shortly");
    }
    if (!res.ok) {
      log.error("sms-http-error", { status: res.status });
      throw ApiError.unavailable("SMS delivery failed — try again shortly");
    }
  }
}

class NoSmsProvider implements SmsProvider {
  readonly name = "none" as const;
  async send() {
    throw ApiError.unavailable(
      "SMS provider is not configured — set TWILIO_* or SMS_GATEWAY_URL (or use a test number +999…)"
    );
  }
}

function buildProvider(): SmsProvider {
  const explicit = env.SMS_PROVIDER;
  const twilioReady = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  const httpReady = !!process.env.SMS_GATEWAY_URL;

  if (explicit === "twilio") {
    if (!twilioReady) return new NoSmsProvider();
    return new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM);
  }
  if (explicit === "http") {
    return httpReady ? new HttpSmsProvider(process.env.SMS_GATEWAY_URL!, process.env.SMS_GATEWAY_TOKEN || "") : new NoSmsProvider();
  }
  if (explicit === "console") return env.NODE_ENV === "production" ? new NoSmsProvider() : new ConsoleSmsProvider();
  if (explicit === "none") return new NoSmsProvider();

  // auto
  if (twilioReady) return new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM);
  if (httpReady) return new HttpSmsProvider(process.env.SMS_GATEWAY_URL!, process.env.SMS_GATEWAY_TOKEN || "");
  return env.NODE_ENV === "production" ? new NoSmsProvider() : new ConsoleSmsProvider();
}

const globalForSms = globalThis as unknown as { __smsProvider?: SmsProvider };

/** Active provider (process-lifetime singleton; re-evaluates per boot). */
export function getSmsProvider(): SmsProvider {
  if (!globalForSms.__smsProvider) globalForSms.__smsProvider = buildProvider();
  return globalForSms.__smsProvider;
}

/** A provider that actually delivers SMS (twilio/http) — vs console/none. */
export function hasRealSmsProvider(): boolean {
  const p = getSmsProvider().name;
  return p === "twilio" || p === "http";
}

export function isTestPhone(phone: string): boolean {
  return env.TEST_PHONE_PREFIXES.some((prefix) => phone.startsWith(prefix.startsWith("+") ? prefix : `+${prefix}`));
}

/** Test phones are dev/demo-only; production requires explicit opt-in. */
export function assertTestPhonesAllowed() {
  if (!env.ALLOW_TEST_PHONES) {
    throw ApiError.forbidden("Test numbers are disabled on this server — use your real number");
  }
}
