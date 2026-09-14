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

export default function AuthScreen() {
  const t = useT();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("+964");
  const [code, setCode] = useState("");
  const [twofa, setTwofa] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setMe = useStore((s) => s.setMe);

  const requestOtp = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ sent: boolean; devCode?: string }>("auth/request-otp", { phone: phone.trim() });
      setDevCode(res.devCode || null);
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
                <Button className="w-full bg-teal-500 hover:bg-teal-400 text-teal-950 font-bold" disabled={busy} onClick={requestOtp}>
                  {t.sendCode}
                </Button>
              </>
            )}

            {step === "otp" && (
              <>
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
                />
                {devCode && (
                  <p className="text-xs text-amber-300/90 text-center">
                    {t.devCodeNote}: <span className="font-mono font-bold text-amber-200" dir="ltr">{devCode}</span>
                  </p>
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
