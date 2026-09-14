"use client";
// Settings (spec screens 16-21 + §49, §55-62, §32): profile, privacy,
// notifications, devices, storage, blocked users, 2FA, language, theme,
// data export, account deletion.
import { useEffect, useState, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { useStore } from "@/lib/client/store";
import { get, patch, post, del } from "@/lib/client/api";
import { uploadFile } from "@/lib/client/media";
import { useTheme } from "next-themes";
import { subscribeToPush } from "@/lib/client/push";
import { mediaStats } from "@/lib/client/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  User, Lock, Bell, MonitorSmartphone, HardDrive, Ban, KeyRound, Globe, Sun, Moon,
  LogOut, Trash2, Download, ChevronLeft, Check, Copy, ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Section = "root" | "profile" | "privacy" | "notifications" | "devices" | "storage" | "blocked" | "twofa" | "password";

export default function SettingsScreen() {
  const t = useT();
  const [section, setSection] = useState<Section>("root");
  const me = useStore((s) => s.me);
  const setMe = useStore((s) => s.setMe);
  const setView = useStore((s) => s.setView);

  if (section !== "root") {
    return (
      <div className="h-full flex flex-col">
        <header className="h-14 flex items-center gap-2 px-3 border-b bg-teal-950 text-teal-50">
          <Button variant="ghost" size="icon" className="text-teal-100" onClick={() => setSection("root")} aria-label="back">
            <ChevronLeft className="w-5 h-5 rtl:rotate-180" />
          </Button>
          <h1 className="font-bold text-sm">{sectionTitle(section, t)}</h1>
        </header>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 max-w-lg mx-auto">
            {section === "profile" && <ProfileSection onSaved={(u) => setMe(u as never)} />}
            {section === "privacy" && <PrivacySection />}
            {section === "notifications" && <NotificationsSection />}
            {section === "devices" && <DevicesSection />}
            {section === "storage" && <StorageSection />}
            {section === "blocked" && <BlockedSection />}
            {section === "twofa" && <TwofaSection />}
            {section === "password" && <PasswordSection />}
          </div>
        </ScrollArea>
      </div>
    );
  }

  const logout = async () => {
    await post("auth/logout", {}).catch(() => undefined);
    location.reload();
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 flex items-center px-3 border-b bg-teal-950 text-teal-50">
        <h1 className="font-bold">{t.settings}</h1>
      </header>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 max-w-lg mx-auto space-y-4">
          {/* profile card */}
          <button onClick={() => setSection("profile")} className="w-full flex items-center gap-3 p-3 rounded-xl border hover:bg-muted/60 text-start">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-teal-400 to-teal-700 text-white flex items-center justify-center text-xl font-bold">
              {me?.displayName?.charAt(0) || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold truncate">{me?.displayName}</p>
              <p className="text-sm text-muted-foreground" dir="ltr">{me?.username ? `@${me.username}` : me?.phone || me?.email}</p>
            </div>
            <User className="w-4 h-4 text-muted-foreground" />
          </button>

          <SettingsRow icon={<Lock className="w-4 h-4" />} label={t.privacy} onClick={() => setSection("privacy")} />
          <SettingsRow icon={<Bell className="w-4 h-4" />} label={t.notifications} onClick={() => setSection("notifications")} />
          <SettingsRow icon={<MonitorSmartphone className="w-4 h-4" />} label={t.devices} onClick={() => setSection("devices")} />
          <SettingsRow icon={<HardDrive className="w-4 h-4" />} label={t.storage} onClick={() => setSection("storage")} />
          <SettingsRow icon={<Ban className="w-4 h-4" />} label={t.blockedUsers} onClick={() => setSection("blocked")} />
          <SettingsRow icon={<KeyRound className="w-4 h-4" />} label={t.twofa} onClick={() => setSection("twofa")} />
          <SettingsRow icon={<Lock className="w-4 h-4" />} label={t.passwordSettings} onClick={() => setSection("password")} />

          {/* language */}
          <LanguageRow />
          {/* theme */}
          <ThemeRow />
          {/* admin shortcut */}
          <SettingsRow icon={<ShieldCheck className="w-4 h-4" />} label={t.adminPanel} onClick={() => setView("admin")} />

          <div className="pt-2 space-y-2">
            <a href="/api/v1/users/me/export" download className="block">
              <Button variant="outline" className="w-full"><Download className="w-4 h-4 me-2" />{t.exportData}</Button>
            </a>
            <Button variant="outline" className="w-full" onClick={logout}><LogOut className="w-4 h-4 me-2 rtl:-scale-x-100" />{t.logout}</Button>
            <DangerZone />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function sectionTitle(s: Section, t: ReturnType<typeof useT>): string {
  const map: Record<Section, string> = {
    root: t.settings, profile: t.profile, privacy: t.privacy, notifications: t.notifications,
    devices: t.devices, storage: t.storage, blocked: t.blockedUsers, twofa: t.twofa,
    password: t.passwordSettings,
  };
  return map[s];
}

function SettingsRow({ icon, label, onClick, sub }: { icon: ReactNode; label: string; onClick: () => void; sub?: string }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-3 rounded-xl border hover:bg-muted/60 text-start">
      <span className="text-teal-600">{icon}</span>
      <span className="flex-1">
        <span className="text-sm font-medium block">{label}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </span>
      <ChevronLeft className="w-4 h-4 text-muted-foreground rtl:rotate-180" />
    </button>
  );
}

function ProfileSection({ onSaved }: { onSaved: (u: Record<string, unknown>) => void }) {
  const t = useT();
  const me = useStore((s) => s.me);
  const [name, setName] = useState(me?.displayName || "");
  const [username, setUsername] = useState(me?.username || "");
  const [bio, setBio] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  // username is mandatory: valid format + (unchanged or available)
  const uname = username.trim();
  const usernameChanged = uname !== (me?.username || "");
  const [usernameAvailable, setUsernameAvailable] = useState(true);

  useEffect(() => {
    get<{ bio: string | null }>("users/me").then((p) => setBio(p.bio || "")).catch(() => undefined);
  }, []);

  // live availability when the username changed (debounced)
  useEffect(() => {
    if (!usernameChanged || !/^[a-zA-Z0-9_]{4,32}$/.test(uname)) return;
    const timer = setTimeout(() => {
      get<{ available: boolean }>(`users/username-available?u=${encodeURIComponent(uname)}`)
        .then((r) => setUsernameAvailable(!!r?.available))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [uname, usernameChanged]);

  const uploadAvatar = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const buf = await file.arrayBuffer();
        const up = await uploadFile({ buffer: buf, name: file.name, mime: file.type, size: file.size }, "avatar").promise;
        const updated = await patch<Record<string, unknown>>("users/me", { avatarMediaId: up.mediaId });
        onSaved({ ...(me || {}), ...updated });
        setSaved(true);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  const save = async () => {
    setError("");
    if (!name.trim() || !/^[a-zA-Z0-9_]{4,32}$/.test(uname) || (usernameChanged && !usernameAvailable)) return;
    try {
      const updated = await patch<Record<string, unknown>>("users/me", {
        displayName: name.trim(),
        username: uname,
        bio,
      });
      onSaved({ ...(me || {}), ...updated });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <button onClick={uploadAvatar} className="mx-auto block" aria-label={t.photo}>
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-teal-400 to-teal-700 text-white flex items-center justify-center text-2xl font-bold relative">
          {me?.displayName?.charAt(0) || "?"}
          <span className="absolute bottom-0 end-0 w-6 h-6 rounded-full bg-teal-600 flex items-center justify-center text-[10px]">✏️</span>
        </div>
        {uploading && <p className="text-xs text-muted-foreground mt-1">{t.uploading}…</p>}
      </button>
      <Label>{t.displayName}</Label>
      <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t.displayName} />
      <Label>{t.username}</Label>
      <Input dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))} placeholder={t.usernameHint} aria-label={t.username} />
      {usernameChanged && uname.length >= 4 && (
        <p className={"text-xs " + (usernameAvailable ? "text-emerald-600" : "text-destructive")} role="status">
          {usernameAvailable ? t.usernameAvailable : t.usernameTaken}
        </p>
      )}
      <Label>{t.bio}</Label>
      <Input value={bio} onChange={(e) => setBio(e.target.value.slice(0, 280))} aria-label={t.bio} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button className="w-full bg-teal-600 hover:bg-teal-500" disabled={!name.trim() || !/^[a-zA-Z0-9_]{4,32}$/.test(uname) || (usernameChanged && !usernameAvailable)} onClick={save}>
        {saved ? <Check className="w-4 h-4" /> : t.save}
      </Button>
    </div>
  );
}

function PrivacySection() {
  const t = useT();
  const [privacy, setPrivacy] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    get<Record<string, string | boolean>>("users/privacy").then(setPrivacy).catch(() => undefined);
  }, []);
  const set = (k: string, v: string | boolean) => {
    setPrivacy((p) => ({ ...p, [k]: v }));
    patch("users/privacy", { [k]: v }).catch(() => undefined);
  };
  const rows: Array<[string, string]> = [
    ["lastSeenVisibility", t.lastSeenVisibility],
    ["phoneVisibility", t.phoneVisibility],
    ["photoVisibility", t.photoVisibility],
    ["whoCanMessageMe", t.whoCanMessageMe],
  ];
  return (
    <div className="space-y-4">
      {rows.map(([k, label]) => (
        <div key={k} className="space-y-1">
          <Label>{label}</Label>
          <Select value={(privacy[k] as string) || "everyone"} onValueChange={(v) => set(k, v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">{t.everyone}</SelectItem>
              <SelectItem value="contacts">{t.contactsOnly}</SelectItem>
              <SelectItem value="nobody">{t.nobody}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
      <div className="flex items-center justify-between p-3 border rounded-xl">
        <Label htmlFor="readreceipts">{t.readReceipts}</Label>
        <Switch id="readreceipts" checked={!!privacy.readReceipts} onCheckedChange={(v) => set("readReceipts", v)} />
      </div>
    </div>
  );
}

function NotificationsSection() {
  const t = useT();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [pushOn, setPushOn] = useState(false);

  useEffect(() => {
    get<Record<string, boolean>>("notifications/prefs").then(setPrefs).catch(() => undefined);
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- reading external permission state */
    if (typeof Notification !== "undefined") setPushOn(Notification.permission === "granted");
  }, []);

  const set = (k: string, v: boolean) => {
    setPrefs((p) => ({ ...p, [k]: v }));
    patch("notifications/prefs", { [k]: v }).catch(() => undefined);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 border rounded-xl">
        <Label htmlFor="nenabled">{t.notifEnabled}</Label>
        <Switch id="nenabled" checked={prefs.enabled !== false} onCheckedChange={(v) => set("enabled", v)} />
      </div>
      <div className="flex items-center justify-between p-3 border rounded-xl">
        <Label htmlFor="ntext">{t.showMessageText}</Label>
        <Switch id="ntext" checked={prefs.showMessageText !== false} onCheckedChange={(v) => set("showMessageText", v)} />
      </div>
      {[
        ["privateEnabled", t.privateChats],
        ["groupsEnabled", t.groupChats],
        ["channelsEnabled", t.channels],
      ].map(([k, label]) => (
        <div key={k} className="flex items-center justify-between p-3 border rounded-xl">
          <Label htmlFor={k}>{label}</Label>
          <Switch id={k} checked={prefs[k] !== false} onCheckedChange={(v) => set(k, v)} />
        </div>
      ))}
      <Button variant="outline" className="w-full" disabled={pushOn} onClick={() => subscribeToPush().then(setPushOn)}>
        {pushOn ? <><Check className="w-4 h-4 me-2" />{t.pushEnabled}</> : t.enablePush}
      </Button>
    </div>
  );
}

interface SessionRow {
  id: string;
  deviceName: string;
  platform: string;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

function DevicesSection() {
  const t = useT();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  useEffect(() => {
    get<SessionRow[]>("sessions").then(setSessions).catch(() => undefined);
  }, []);

  const revoke = async (id: string) => {
    await post(`sessions/${id}/revoke`, {}).catch(() => undefined);
    get<SessionRow[]>("sessions").then(setSessions).catch(() => undefined);
  };

  const revokeAll = async () => {
    if (!confirm(t.logoutAll + "?")) return;
    await post("sessions/revoke-all", {}).catch(() => undefined);
    get<SessionRow[]>("sessions").then(setSessions).catch(() => undefined);
  };

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <div key={s.id} className={cn("flex items-center gap-3 p-3 border rounded-xl", s.isCurrent && "border-teal-500/50 bg-teal-500/5")}>
          <MonitorSmartphone className="w-5 h-5 text-teal-600" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{s.deviceName} {s.isCurrent && <Badge className="ms-1">{t.system === "System" ? "current" : "هذا الجهاز"}</Badge>}</p>
            <p className="text-xs text-muted-foreground" dir="ltr">{s.platform}{s.ip ? ` · ${s.ip}` : ""} · {new Date(s.lastActiveAt).toLocaleString()}</p>
          </div>
          {!s.isCurrent && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(s.id)}>{t.logout}</Button>
          )}
        </div>
      ))}
      <Button variant="destructive" className="w-full" onClick={revokeAll}>{t.logoutAll}</Button>
    </div>
  );
}

function StorageSection() {
  const t = useT();
  const [stats, setStats] = useState<{ byKind: Record<string, { count: number; bytes: number }>; totalBytes: number } | null>(null);
  useEffect(() => {
    mediaStats().then(setStats).catch(() => undefined);
  }, []);

  const fmt = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
  const kinds: Array<[string, string]> = [
    ["image", t.images], ["video", t.videos], ["voice", t.audio], ["audio", t.audio], ["document", t.documents],
  ];

  const clearCache = async () => {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    alert(t.cacheCleared);
  };

  return (
    <div className="space-y-3">
      <div className="p-4 border rounded-xl text-center">
        <p className="text-2xl font-bold text-teal-600">{stats ? fmt(stats.totalBytes) : "—"}</p>
        <p className="text-xs text-muted-foreground">{t.totalUsage}</p>
      </div>
      {kinds.map(([k, label]) => (
        <div key={k} className="flex items-center justify-between p-3 border rounded-xl">
          <span className="text-sm">{label}</span>
          <span className="text-sm text-muted-foreground">{stats?.byKind[k] ? `${fmt(stats.byKind[k].bytes)} · ${stats.byKind[k].count}` : "—"}</span>
        </div>
      ))}
      <Button variant="outline" className="w-full" onClick={clearCache}>{t.clearCache}</Button>
    </div>
  );
}

function BlockedSection() {
  const t = useT();
  const [blocked, setBlocked] = useState<Array<{ id: string; displayName: string; username: string | null }>>([]);
  useEffect(() => {
    get<Array<{ id: string; displayName: string; username: string | null }>>("users/blocked").then(setBlocked).catch(() => undefined);
  }, []);
  return (
    <div className="space-y-2">
      {blocked.map((u) => (
        <div key={u.id} className="flex items-center gap-3 p-3 border rounded-xl">
          <Ban className="w-4 h-4 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{u.displayName}</p>
            {u.username && <p className="text-xs text-muted-foreground" dir="ltr">@{u.username}</p>}
          </div>
          <Button size="sm" variant="outline" onClick={async () => { await post(`users/${u.id}/unblock`, {}); setBlocked(blocked.filter((b) => b.id !== u.id)); }}>
            {t.unblock}
          </Button>
        </div>
      ))}
      {blocked.length === 0 && <p className="text-center text-sm text-muted-foreground p-4">—</p>}
    </div>
  );
}

function TwofaSection() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    get<{ twofaEnabled: boolean }>("users/me").then((u) => setEnabled(u.twofaEnabled)).catch(() => undefined);
  }, []);

  const start = async () => {
    setSetup(await post<{ secret: string; otpauthUri: string }>("auth/2fa/setup", {}));
  };
  const confirm = async () => {
    setError("");
    try {
      await post("auth/2fa/enable", { code });
      setEnabled(true);
      setSetup(null);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const disable = async () => {
    setError("");
    try {
      await post("auth/2fa/disable", { code });
      setEnabled(false);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (enabled === null) return null;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.twofaHint}</p>
      {enabled ? (
        <>
          <div className="flex items-center gap-2 text-emerald-600 text-sm"><ShieldCheck className="w-4 h-4" /> {t.pushEnabled}</div>
          <Input dir="ltr" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="text-center tracking-widest" />
          <Button variant="destructive" className="w-full" onClick={disable}>{t.disable}</Button>
        </>
      ) : setup ? (
        <>
          <div className="p-3 bg-muted rounded-lg text-center">
            <p className="text-xs text-muted-foreground mb-2">secret:</p>
            <code className="text-xs break-all" dir="ltr">{setup.secret}</code>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => navigator.clipboard.writeText(setup.secret)}>
              <Copy className="w-3 h-3 me-1" />{t.copy}
            </Button>
          </div>
          <Input dir="ltr" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="text-center tracking-widest" />
          <Button className="w-full bg-teal-600 hover:bg-teal-500" onClick={confirm}>{t.enable}</Button>
        </>
      ) : (
        <Button className="w-full bg-teal-600 hover:bg-teal-500" onClick={start}>{t.enable}</Button>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PasswordSection() {
  const t = useT();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ hasPassword: boolean }>("users/me/password").then((r) => setHasPassword(r.hasPassword)).catch(() => setHasPassword(false));
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await post("users/me/password", {
        ...(hasPassword ? { currentPassword: current } : {}),
        newPassword: next,
      });
      setHasPassword(true);
      setCurrent("");
      setNext("");
      setMsg(t.passwordSaved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (hasPassword === null) return null;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.passwordSettingsHint}</p>
      {hasPassword && (
        <>
          <Label htmlFor="cur-pw">{t.currentPassword}</Label>
          <Input id="cur-pw" dir="ltr" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </>
      )}
      <Label htmlFor="new-pw">{hasPassword ? t.newPassword : t.password}</Label>
      <Input id="new-pw" dir="ltr" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      <p className="text-xs text-muted-foreground">{t.passwordPolicyHint}</p>
      <Button className="w-full bg-teal-600 hover:bg-teal-500" disabled={busy || next.length < 8 || (hasPassword && !current)} onClick={save}>
        {hasPassword ? t.changePasswordBtn : t.setPasswordBtn}
      </Button>
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function LanguageRow() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border">
      <Globe className="w-4 h-4 text-teal-600" />
      <Label className="flex-1">{t.language}</Label>
      <Select value={locale} onValueChange={(v) => setLocale(v as "ar" | "en")}>
        <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ar">العربية</SelectItem>
          <SelectItem value="en">English</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function ThemeRow() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border">
      {theme === "dark" ? <Moon className="w-4 h-4 text-teal-600" /> : <Sun className="w-4 h-4 text-amber-500" />}
      <Label className="flex-1">{t.theme}</Label>
      <Select value={theme || "system"} onValueChange={setTheme}>
        <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="light">{t.light}</SelectItem>
          <SelectItem value="dark">{t.dark}</SelectItem>
          <SelectItem value="system">{t.system}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function DangerZone() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const openDialog = async () => {
    setPassword("");
    setError("");
    const pw = await get<{ hasPassword: boolean }>("users/me/password").catch(() => ({ hasPassword: false }));
    setHasPassword(!!pw?.hasPassword);
    setOpen(true);
  };

  const doDelete = async () => {
    setBusy(true);
    setError("");
    try {
      await post("users/me/delete", hasPassword ? { password } : {});
      setOpen(false);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="ghost" className="w-full text-destructive" onClick={openDialog}>
        <Trash2 className="w-4 h-4 me-2" />{t.deleteAccount}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t.deleteAccount}</DialogTitle></DialogHeader>
          <p className="text-sm text-destructive">{t.deleteAccountWarn}</p>
          <p className="text-xs text-muted-foreground" dir="auto">{t.deleteAccountUsername}</p>
          {hasPassword && (
            <div className="space-y-1">
              <Label htmlFor="del-pw">{t.deleteAccountPassword}</Label>
              <Input
                id="del-pw"
                dir="ltr"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t.cancel}</Button>
            <Button
              variant="destructive"
              disabled={busy || (hasPassword && !password)}
              onClick={doDelete}
            >
              {t.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
