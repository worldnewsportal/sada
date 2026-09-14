"use client";
// Auth flow (spec screens 2-4): phone → OTP → (2FA) → profile setup.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { useStore } from "@/lib/client/store";
import { api, post, ApiClientError } from "@/lib/client/api";

type Step = "phone" | "otp" | "twofa" | "profile";
type Delivery = "test" | "sms" | "dev" | null;

// Must mirror server TEST_PHONE_PREFIXES default (+999 — unassigned country
// code, collision-free). Server remains the source of truth; this only
// drives UI affordances (badge/hint) before the request round-trips.
const TEST_PREFIX = "+999";
const isTestPhoneLocal = (phone: string) => phone.replace(/[\s()-]/g, "").startsWith(TEST_PREFIX);

export default function AuthScreen() {
  const t = useT();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("+964");
  const [code, setCode] = useState("");
  const [twofa, setTwofa] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery>(null);
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setMe = useStore((s) => s.setMe);

  const requestOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ sent: boolean; delivery?: Delivery; devCode?: string }>("auth/request-otp", { phone: phone.trim() });
      setDevCode(res.devCode || null);
      setDelivery(res.delivery || (res.devCode ? "dev" : "sms"));
      setStep("otp");
    } catch (e) {
      setError((e as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{
        status: string;
        twofaTicket?: string;
        user?: Record<string, unknown>;
      }>("auth/verify-otp", { phone: phone.trim(), code: code.trim(), deviceName: detectDevice(), platform: "web" });
      if (res.status === "twofa_required" && res.twofaTicket) {
        setTicket(res.twofaTicket);
        setStep("twofa");
        return;
      }
      await afterLogin();
    } catch (e) {
      setError((e as ApiClientError).message);
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
      setError((e as ApiClientError).message);
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
    // brand-new account (default name, no username) → profile setup step
    if (!profile.username && /^User \d+$/.test(profile.displayName)) {
      setName("");
      setStep("profile");
      return;
    }
    setMe(profile as never);
    useStore.getState().setView("chats");
  };

  const saveProfile = async () => {
    setBusy(true);
    setError("");
    try {
      await api("users/me", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: name.trim() || undefined,
          username: username.trim() || null,
        }),
      });
      await afterLogin();
    } catch (e) {
      setError((e as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  };

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
                <label className="text-sm text-teal-200">{t.phone}</label>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                  placeholder={t.phoneHint}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && requestOtp()}
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
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy} onClick={requestOtp}>
                  {t.sendCode}
                </Button>
              </>
            )}

            {step === "otp" && (
              <>
                {delivery === "test" ? (
                  <p className="text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-center" dir="rtl">
                    🧪 {t.testModeNote}
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
                  {t.codeSentTo} <span dir="ltr" className="font-bold">{phone}</span>
                </p>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-center text-xl tracking-[0.5em]"
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
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
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy || code.length < 4} onClick={verifyOtp}>
                  {t.verifyCode}
                </Button>
                <Button variant="ghost" className="w-full text-teal-300" onClick={() => setStep("phone")}>
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
                <label className="text-xs text-teal-300">{t.username}</label>
                <Input
                  dir="ltr"
                  className="bg-teal-950/60 border-teal-700 text-teal-50 text-left"
                  placeholder={t.usernameHint}
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))}
                  aria-label={t.username}
                />
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy || !name.trim()} onClick={saveProfile}>
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
