"use client";
// Auth flow (spec screens 2-4): phone → OTP → (2FA) → profile setup.
// Dual registration: phone (+999 test / real SMS) OR email (activation code
// + welcome mail, optional signup password, password login).
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { useStore } from "@/lib/client/store";
import { api, post, ApiClientError } from "@/lib/client/api";

type Step = "phone" | "otp" | "twofa" | "profile";
type Method = "phone" | "email";
type EmailIntent = "signup" | "login";
type EmailLoginMode = "code" | "password";
type Delivery = "test" | "sms" | "dev" | "email" | null;
type UsernameStatus = "idle" | "checking" | "ok" | "taken" | "invalid" | "reserved";

// Must mirror server TEST_PHONE_PREFIXES default (+999 — unassigned country
// code, collision-free). Server remains the source of truth; this only
// drives UI affordances (badge/hint) before the request round-trips.
const TEST_PREFIX = "+999";
const isTestPhoneLocal = (phone: string) => phone.replace(/[\s()-]/g, "").startsWith(TEST_PREFIX);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{4,32}$/;

// mirrors server policy (security/password.ts): ≥8 chars, letters + digits
const passwordValid = (p: string) => p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);

export default function AuthScreen() {
  const t = useT();
  const [step, setStep] = useState<Step>("phone");
  const [method, setMethod] = useState<Method>("phone");
  const [phone, setPhone] = useState("+964");
  const [email, setEmail] = useState("");
  const [emailIntent, setEmailIntent] = useState<EmailIntent>("signup");
  const [emailLoginMode, setEmailLoginMode] = useState<EmailLoginMode>("code");
  const [signupPassword, setSignupPassword] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [code, setCode] = useState("");
  const [twofa, setTwofa] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("idle");
  const [needPassword, setNeedPassword] = useState<boolean | null>(null);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery>(null);
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setMe = useStore((s) => s.setMe);

  const fail = (e: unknown) => setError((e as ApiClientError).message || String(e));

  // ---------- PHONE (existing flow) ----------
  const requestPhoneOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ sent: boolean; delivery?: Delivery; devCode?: string }>("auth/request-otp", { phone: phone.trim() });
      // Defensive: a stale cached client talking to a newer server (or vice
      // versa) must never surface a raw TypeError — show a recoverable hint.
      if (!res || typeof res !== "object" || res.sent !== true) {
        throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
      }
      setDevCode(res.devCode || null);
      setDelivery(res.delivery || (res.devCode ? "dev" : "sms"));
      setStep("otp");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verifyPhoneOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{
        status: string;
        twofaTicket?: string;
        user?: Record<string, unknown>;
      }>("auth/verify-otp", { phone: phone.trim(), code: code.trim(), deviceName: detectDevice(), platform: "web" });
      if (!res || typeof res !== "object" || !res.status) {
        throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
      }
      if (res.status === "twofa_required" && res.twofaTicket) {
        setTicket(res.twofaTicket);
        setStep("twofa");
        return;
      }
      await afterLogin();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // ---------- EMAIL ----------
  const requestEmailCode = async (intent: EmailIntent) => {
    if (!EMAIL_RE.test(email.trim())) {
      setError(t.invalidEmail);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await post<{ sent: boolean; delivery?: "email" | "dev"; isNew?: boolean; devCode?: string }>(
        "auth/request-email-otp",
        {
          email: email.trim().toLowerCase(),
          intent,
          // signup: optional password (hashed server-side, applied on activation)
          ...(intent === "signup" && signupPassword ? { password: signupPassword } : {}),
        }
      );
      if (!res || typeof res !== "object" || res.sent !== true) {
        throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
      }
      setDevCode(res.devCode || null);
      setDelivery(res.delivery || (res.devCode ? "dev" : "email"));
      setStep("otp");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const loginByEmailPassword = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ status: string; twofaTicket?: string }>("auth/login-password", {
        identifier: email.trim().toLowerCase(),
        password: loginPassword,
        deviceName: detectDevice(),
        platform: "web",
      });
      if (!res || typeof res !== "object" || !res.status) {
        throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
      }
      if (res.status === "twofa_required" && res.twofaTicket) {
        setTicket(res.twofaTicket);
        setStep("twofa");
        return;
      }
      await afterLogin();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verifyEmailOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ status: string; twofaTicket?: string }>("auth/verify-email-otp", {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        deviceName: detectDevice(),
        platform: "web",
      });
      if (!res || typeof res !== "object" || !res.status) {
        throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
      }
      if (res.status === "twofa_required" && res.twofaTicket) {
        setTicket(res.twofaTicket);
        setStep("twofa");
        return;
      }
      await afterLogin();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verifyTwofa = async () => {
    setBusy(true);
    setError("");
    try {
      await post("auth/twofa", { ticket, code: twofa.trim(), deviceName: detectDevice(), platform: "web" });
      await afterLogin();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const afterLogin = async () => {
    const profile = await api<{
      id: string;
      displayName: string;
      username: string | null;
      bio?: string;
    }>("users/me");
    if (!profile || typeof profile !== "object" || !profile.id) {
      throw new ApiClientError("BAD_RESPONSE", t.badResponse, 0);
    }
    // brand-new account (default name, no username) → profile setup step
    if (!profile.username && /^User \d+$/.test(profile.displayName)) {
      setName("");
      setUsername("");
      setUsernameStatus("idle");
      setNewPw("");
      setConfirmPw("");
      // password is mandatory for new accounts: phone accounts (and any
      // passwordless path) set it here; email signups already have one
      const pw = await api<{ hasPassword: boolean }>("users/me/password").catch(() => ({ hasPassword: false }));
      setNeedPassword(!pw?.hasPassword);
      setStep("profile");
      return;
    }
    setMe(profile as never);
    useStore.getState().setView("chats");
  };

  // live username availability (debounced) — uniqueness is enforced by the
  // server (case-insensitive, reserved forever); this only gives instant UX
  useEffect(() => {
    if (step !== "profile") return;
    const u = username.trim();
    if (!u) {
      setUsernameStatus("idle");
      return;
    }
    if (!USERNAME_RE.test(u)) {
      setUsernameStatus("invalid");
      return;
    }
    setUsernameStatus("checking");
    const timer = setTimeout(() => {
      api<{ available: boolean; reason: string | null }>(`users/username-available?u=${encodeURIComponent(u)}`)
        .then((r) => {
          if (!r || typeof r.available !== "boolean") throw new Error("bad");
          setUsernameStatus(r.available ? "ok" : r.reason === "reserved" ? "reserved" : "taken");
        })
        .catch(() => setUsernameStatus("idle"));
    }, 350);
    return () => clearTimeout(timer);
  }, [username, step]);

  const saveProfile = async () => {
    // mandatory fields: display name + unique username (+ password when the
    // account has none yet — e.g. phone registration)
    if (!name.trim() || usernameStatus !== "ok") return;
    if (needPassword && (!passwordValid(newPw) || newPw !== confirmPw)) return;
    setBusy(true);
    setError("");
    try {
      if (needPassword) {
        await post("users/me/password", { newPassword: newPw });
      }
      await api("users/me", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: name.trim(),
          username: username.trim(),
        }),
      });
      await afterLogin();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const backToStart = () => {
    setStep("phone");
    setCode("");
    setDevCode(null);
    setDelivery(null);
  };

  const verifyCurrent = () => (method === "email" ? verifyEmailOtp() : verifyPhoneOtp());

  // segmented control (tabs)
  const Seg = ({ value, options, onChange }: { value: string; options: { v: string; label: string }[]; onChange: (v: string) => void }) => (
    <div className="grid grid-cols-2 gap-1 bg-teal-950/60 border border-teal-800/60 rounded-xl p-1">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`py-2 text-sm font-bold rounded-lg transition-colors ${
            value === o.v ? "bg-teal-500 text-teal-950 shadow" : "text-teal-300 hover:text-teal-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-b from-teal-950 to-teal-900 p-4 overflow-y-auto">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-teal-50">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-400 to-teal-700 flex items-center justify-center shadow-xl">
            <svg width="34" height="34" viewBox="0 0 44 44" fill="none">
              <path d="M10 22 v0" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
              <path d="M17 15 v14" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
              <path d="M24 10 v24" stroke="#fbbf24" strokeWidth="5" strokeLinecap="round" />
              <path d="M31 15 v14" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
              <path d="M38 19 v6" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold">{t.appName}</h1>
          <p className="text-sm text-teal-300">{t.tagline}</p>
        </div>

        <Card className="border-teal-800/40 bg-teal-900/40 backdrop-blur border">
          <CardContent className="pt-6 space-y-4">
            {step === "phone" && (
              <>
                <Seg
                  value={method}
                  options={[
                    { v: "phone", label: `📱 ${t.methodPhone}` },
                    { v: "email", label: `✉️ ${t.methodEmail}` },
                  ]}
                  onChange={(v) => {
                    setMethod(v as Method);
                    setError("");
                  }}
                />

                {method === "phone" && (
                  <>
                    <label className="text-sm text-teal-200">{t.phone}</label>
                    <Input
                      dir="ltr"
                      className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                      placeholder={t.phoneHint}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && requestPhoneOtp()}
                      inputMode="tel"
                      aria-label={t.phone}
                    />
                    {isTestPhoneLocal(phone) && (
                      <p className="text-xs font-medium text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2" dir="rtl">
                        🧪 {t.testModeBadge}
                      </p>
                    )}
                    <details className="text-xs text-teal-300/80">
                      <summary className="cursor-pointer select-none hover:text-teal-200">{t.testModeBadge}؟</summary>
                      <p className="mt-2 leading-relaxed" dir="rtl">{t.testModeHint}</p>
                    </details>
                    <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy} onClick={requestPhoneOtp}>
                      {t.sendCode}
                    </Button>
                  </>
                )}

                {method === "email" && (
                  <>
                    <label className="text-sm text-teal-200">{t.emailLabel}</label>
                    <Input
                      dir="ltr"
                      type="email"
                      autoComplete="email"
                      className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                      placeholder="name@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      inputMode="email"
                      aria-label={t.emailLabel}
                    />
                    <Seg
                      value={emailIntent}
                      options={[
                        { v: "signup", label: t.tabSignup },
                        { v: "login", label: t.tabLogin },
                      ]}
                      onChange={(v) => {
                        setEmailIntent(v as EmailIntent);
                        setError("");
                      }}
                    />

                    {emailIntent === "signup" ? (
                      <>
                        <label className="text-xs text-teal-300">{t.password} <span className="text-amber-300">*{t.required}</span></label>
                        <Input
                          dir="ltr"
                          type="password"
                          autoComplete="new-password"
                          className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                          value={signupPassword}
                          onChange={(e) => setSignupPassword(e.target.value)}
                          aria-label={t.password}
                        />
                        <p className="text-[11px] text-teal-400/80" dir="rtl">{t.passwordPolicyHint}</p>
                        <p className="text-xs text-teal-300/80 text-center" dir="rtl">{t.activationSent}</p>
                        <Button
                          className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold"
                          disabled={busy || !email.trim() || !passwordValid(signupPassword)}
                          onClick={() => requestEmailCode("signup")}
                        >
                          {t.createAccountBtn}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Seg
                          value={emailLoginMode}
                          options={[
                            { v: "code", label: t.byActivationCode },
                            { v: "password", label: t.byPassword },
                          ]}
                          onChange={(v) => {
                            setEmailLoginMode(v as EmailLoginMode);
                            setError("");
                          }}
                        />
                        {emailLoginMode === "code" ? (
                          <Button
                            className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold"
                            disabled={busy || !email.trim()}
                            onClick={() => requestEmailCode("login")}
                          >
                            {t.sendLoginCode}
                          </Button>
                        ) : (
                          <>
                            <label className="text-xs text-teal-300">{t.password}</label>
                            <Input
                              dir="ltr"
                              type="password"
                              autoComplete="current-password"
                              className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                              value={loginPassword}
                              onChange={(e) => setLoginPassword(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && loginByEmailPassword()}
                              aria-label={t.password}
                            />
                            <Button
                              className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold"
                              disabled={busy || !email.trim() || !loginPassword}
                              onClick={loginByEmailPassword}
                            >
                              {t.login}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {step === "otp" && (
              <>
                {delivery === "test" ? (
                  <p className="text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-center" dir="rtl">
                    🧪 {t.testModeNote}
                  </p>
                ) : delivery === "email" ? (
                  <p className="text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 text-center" dir="rtl">
                    ✉️ {t.emailOtpSent}
                  </p>
                ) : delivery === "dev" ? (
                  <p className="text-xs text-teal-300/90 bg-teal-500/10 border border-teal-500/30 rounded-lg px-3 py-2 text-center" dir="rtl">
                    {t.devEchoNote}
                  </p>
                ) : (
                  <p className="text-xs text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 text-center" dir="rtl">
                    📱 {t.smsSentNote}
                  </p>
                )}
                <p className="text-sm text-teal-200">
                  {t.codeSentTo} <span dir="ltr" className="font-bold">{method === "email" ? email : phone}</span>
                </p>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-center text-xl tracking-[0.5em]"
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && verifyCurrent()}
                  inputMode="numeric"
                  aria-label={t.code}
                  autoComplete="one-time-code"
                />
                {devCode && (
                  <button
                    type="button"
                    onClick={() => setCode(devCode)}
                    className="w-full text-xs text-amber-300/90 bg-amber-500/5 border border-dashed border-amber-500/40 rounded-lg px-3 py-2 hover:bg-amber-500/10 transition-colors"
                    aria-label="fill dev code"
                  >
                    {t.devCodeNote}: <span className="font-mono font-bold text-amber-200" dir="ltr">{devCode}</span>
                    <span className="block text-[10px] text-teal-400/70 mt-1">↖ {t.code}</span>
                  </button>
                )}
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy || code.length < 4} onClick={verifyCurrent}>
                  {t.verifyCode}
                </Button>
                <Button variant="ghost" className="w-full text-teal-300" onClick={backToStart}>
                  {t.resend}
                </Button>
              </>
            )}

            {step === "twofa" && (
              <>
                <p className="text-sm text-teal-200">{t.twofaTitle}</p>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-center text-xl tracking-[0.4em]"
                  placeholder="••••••"
                  value={twofa}
                  onChange={(e) => setTwofa(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  aria-label={t.twofaHint}
                />
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy} onClick={verifyTwofa}>
                  {t.login}
                </Button>
              </>
            )}

            {step === "profile" && (
              <>
                <p className="text-sm font-bold text-teal-100">{t.setupProfile}</p>
                <label className="text-xs text-teal-300">{t.displayName}</label>
                <Input
                  className="bg-teal-950/60 border-teal-700 text-teal-50"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label={t.displayName}
                />
                <label className="text-xs text-teal-300">
                  {t.username} <span className="text-amber-300">*{t.required}</span>
                </label>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                  placeholder={t.usernameHint}
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))}
                  aria-label={t.username}
                />
                {usernameStatus !== "idle" && (
                  <p
                    className={
                      "text-xs px-3 py-1.5 rounded-lg " +
                      (usernameStatus === "ok"
                        ? "text-emerald-300 bg-emerald-500/10"
                        : usernameStatus === "checking"
                          ? "text-teal-300 bg-teal-500/10"
                          : "text-red-300 bg-red-500/10")
                    }
                    role="status"
                  >
                    {usernameStatus === "ok"
                      ? t.usernameAvailable
                      : usernameStatus === "checking"
                        ? t.usernameChecking
                        : usernameStatus === "invalid"
                          ? t.usernameInvalid
                          : usernameStatus === "reserved"
                            ? t.usernameReserved
                            : t.usernameTaken}
                  </p>
                )}
                {needPassword && (
                  <>
                    <label className="text-xs text-teal-300">
                      {t.password} <span className="text-amber-300">*{t.required}</span>
                    </label>
                    <Input
                      dir="ltr"
                      type="password"
                      autoComplete="new-password"
                      className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      aria-label={t.password}
                    />
                    <label className="text-xs text-teal-300">{t.confirmPassword}</label>
                    <Input
                      dir="ltr"
                      type="password"
                      autoComplete="new-password"
                      className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                      value={confirmPw}
                      onChange={(e) => setConfirmPw(e.target.value)}
                      aria-label={t.confirmPassword}
                    />
                    {newPw && (
                      <p className={"text-[11px] " + (passwordValid(newPw) ? "text-emerald-300/80" : "text-amber-300/90")} dir="rtl">
                        {t.passwordPolicyHint}
                      </p>
                    )}
                    {confirmPw && newPw !== confirmPw && (
                      <p className="text-[11px] text-red-300" dir="rtl">{t.passwordMismatch}</p>
                    )}
                  </>
                )}
                <Button
                  className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold"
                  disabled={
                    busy ||
                    !name.trim() ||
                    usernameStatus !== "ok" ||
                    (needPassword === true && (!passwordValid(newPw) || newPw !== confirmPw))
                  }
                  onClick={saveProfile}
                >
                  {t.continue}
                </Button>
              </>
            )}

            {error && <p className="text-sm text-red-300 text-center" role="alert">{error}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function detectDevice(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}
