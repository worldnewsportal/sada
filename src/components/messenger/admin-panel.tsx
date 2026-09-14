"use client";
// Admin panel (spec screen 22, §37): separate auth, stats, users,
// reports queue with actions, chats, audit logs.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { api, post, get } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Shield, Ban, Gavel, ScrollText, Users, MessageSquare, HardDrive, Activity, Search } from "lucide-react";

interface AdminInfo { id: string; username: string; role: string; totpEnabled: boolean }
interface Stats {
  users: number; activeUsers7d: number; messages: number; chats: number; groups: number; channels: number;
  openReports: number; storageBytes: number; mediaObjects: number; failedJobs: number; messagesPerDay: Record<string, number>;
}
interface AdminUserRow {
  id: string; phone: string; username: string | null; displayName: string; createdAt: string;
  bannedUntil: string | null; banReason: string | null; deletedAt: string | null; lastSeenAt: string | null;
  _count: { memberships: number; sentMessages: number };
}
interface ReportRow {
  id: string; reporterId: string; targetType: string; targetId: string; category: string;
  description: string | null; status: string; createdAt: string;
}
interface AuditRow { id: string; actorType: string; actorId: string | null; action: string; targetId: string | null; createdAt: string; ip: string | null }

export default function AdminPanel() {
  const t = useT();
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<AdminInfo>("admin/me").then(setAdmin).catch(() => setAdmin(null));
  }, []);

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ admin: AdminInfo }>("admin/login", { username, password, totp: totp || undefined });
      setAdmin(res.admin);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!admin) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center space-y-1 mb-4">
            <Shield className="w-10 h-10 mx-auto text-teal-500" />
            <h1 className="font-bold text-lg">{t.adminLogin}</h1>
          </div>
          <Input dir="ltr" placeholder="admin" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="username" />
          <Input dir="ltr" type="password" placeholder={t.password} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} aria-label={t.password} />
          <Input dir="ltr" placeholder={t.totpCode} value={totp} onChange={(e) => setTotp(e.target.value)} aria-label={t.totpCode} />
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
          <Button className="w-full bg-teal-600 hover:bg-teal-500" disabled={busy || !password} onClick={login}>{t.login}</Button>
          <p className="text-[10px] text-muted-foreground text-center">
            ADMIN_USERNAME / ADMIN_PASSWORD من ملف .env — يُنشأ تلقائياً عند أول تشغيل
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 flex items-center gap-2 px-3 border-b bg-teal-950 text-teal-50">
        <Shield className="w-5 h-5 text-teal-300" />
        <h1 className="font-bold flex-1">{t.adminPanel}</h1>
        <Badge variant="outline" className="text-teal-300 border-teal-600">{admin.role}</Badge>
        <Button size="sm" variant="ghost" className="text-teal-200" onClick={async () => { await post("auth/logout", {}).catch(() => undefined); location.reload(); }}>
          {t.logout}
        </Button>
      </header>

      <Tabs defaultValue="stats" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-3 mt-2 grid grid-cols-5 w-auto">
          <TabsTrigger value="stats"><Activity className="w-4 h-4" /></TabsTrigger>
          <TabsTrigger value="users"><Users className="w-4 h-4" /></TabsTrigger>
          <TabsTrigger value="reports"><Gavel className="w-4 h-4" /></TabsTrigger>
          <TabsTrigger value="chats"><MessageSquare className="w-4 h-4" /></TabsTrigger>
          <TabsTrigger value="audit"><ScrollText className="w-4 h-4" /></TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1">
          <div className="p-4 max-w-3xl mx-auto">
            <TabsContent value="stats" className="mt-0"><StatsTab /></TabsContent>
            <TabsContent value="users" className="mt-0"><UsersTab /></TabsContent>
            <TabsContent value="reports" className="mt-0"><ReportsTab /></TabsContent>
            <TabsContent value="chats" className="mt-0"><ChatsTab /></TabsContent>
            <TabsContent value="audit" className="mt-0"><AuditTab /></TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

function StatsTab() {
  const t = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { get<Stats>("admin/stats").then(setStats).catch(() => undefined); }, []);
  if (!stats) return null;
  const fmt = (b: number) => (b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard icon={<Users className="w-4 h-4" />} label={t.totalUsers} value={stats.users} />
        <StatCard icon={<Activity className="w-4 h-4" />} label={t.activeUsers} value={stats.activeUsers7d} />
        <StatCard icon={<MessageSquare className="w-4 h-4" />} label={t.totalMessages} value={stats.messages} />
        <StatCard icon={<HardDrive className="w-4 h-4" />} label={t.storageUsed} value={fmt(stats.storageBytes)} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label={t.chats} value={stats.chats} />
        <StatCard label={t.groupChats} value={stats.groups} />
        <StatCard label={t.channels} value={stats.channels} />
        <StatCard label={t.reportsQueue} value={stats.openReports} highlight={stats.openReports > 0} />
      </div>
      <div className="border rounded-xl p-3">
        <p className="text-xs font-semibold text-muted-foreground mb-2">messages / day (7d)</p>
        <div className="flex items-end gap-1 h-24">
          {Object.entries(stats.messagesPerDay).sort().map(([d, n]) => {
            const max = Math.max(...Object.values(stats.messagesPerDay), 1);
            return (
              <div key={d} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full bg-teal-500/70 rounded-t" style={{ height: `${(n / max) * 100}%` }} title={`${d}: ${n}`} />
                <span className="text-[8px] text-muted-foreground">{d.slice(5)}</span>
              </div>
            );
          })}
          {Object.keys(stats.messagesPerDay).length === 0 && <p className="text-xs text-muted-foreground">—</p>}
        </div>
      </div>
      {stats.failedJobs > 0 && (
        <p className="text-xs text-amber-600">⚠ failed jobs: {stats.failedJobs} (see worker logs)</p>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, highlight }: { icon?: React.ReactNode; label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`border rounded-xl p-3 ${highlight ? "border-amber-500/60 bg-amber-500/5" : ""}`}>
      <p className="text-[10px] text-muted-foreground flex items-center gap-1">{icon} {label}</p>
      <p className="text-lg font-bold mt-1">{value}</p>
    </div>
  );
}

function UsersTab() {
  const t = useT();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [banDialog, setBanDialog] = useState<AdminUserRow | null>(null);
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");

  const load = (query: string) => get<AdminUserRow[]>(`admin/users?q=${encodeURIComponent(query)}`).then(setUsers).catch(() => undefined);
  useEffect(() => { load(""); }, []);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => { setQ(e.target.value); load(e.target.value); }} placeholder={t.search} className="ps-9" />
      </div>
      {users.map((u) => {
        const banned = u.bannedUntil && new Date(u.bannedUntil) > new Date();
        return (
          <div key={u.id} className="flex items-center gap-2 p-3 border rounded-xl">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {u.displayName}
                {banned && <Badge className="ms-1 bg-red-500/15 text-red-500 border-0">banned</Badge>}
                {u.deletedAt && <Badge className="ms-1 bg-muted text-muted-foreground border-0">deleted</Badge>}
              </p>
              <p className="text-xs text-muted-foreground truncate" dir="ltr">
                {u.phone}{u.username ? ` · @${u.username}` : ""} · {u._count.sentMessages} msgs · {new Date(u.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button size="sm" variant={banned ? "outline" : "ghost"} className={banned ? "" : "text-destructive"} onClick={() => setBanDialog(u)}>
              {banned ? t.unban : t.ban}
            </Button>
          </div>
        );
      })}

      <Dialog open={!!banDialog} onOpenChange={(v) => !v && setBanDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t.ban} — {banDialog?.displayName}</DialogTitle></DialogHeader>
          {banDialog?.bannedUntil && new Date(banDialog.bannedUntil) > new Date() ? (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={async () => {
                  await post(`admin/users/${banDialog.id}/ban`, { days: 0, reason: "" });
                  setBanDialog(null);
                  load(q);
                }}
              >
                {t.unban}
              </Button>
            </DialogFooter>
          ) : (
            <>
              <Input placeholder={t.banDays} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} dir="ltr" />
              <Input placeholder={t.banReason} value={reason} onChange={(e) => setReason(e.target.value)} />
              <DialogFooter>
                <Button variant="ghost" onClick={() => setBanDialog(null)}>{t.cancel}</Button>
                <Button
                  variant="destructive"
                  onClick={async () => {
                    await post(`admin/users/${banDialog!.id}/ban`, { days: days ? parseInt(days) : null, reason });
                    setBanDialog(null);
                    load(q);
                  }}
                >
                  <Ban className="w-4 h-4 me-1" />{t.ban}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReportsTab() {
  const t = useT();
  const [reports, setReports] = useState<ReportRow[]>([]);
  const load = () => get<ReportRow[]>("admin/reports?status=open").then(setReports).catch(() => undefined);
  useEffect(() => { load(); }, []);

  const resolve = async (r: ReportRow, action: "none" | "ban_user" | "delete_message") => {
    await post(`admin/reports/${r.id}/resolve`, { resolution: action === "none" ? "dismissed-content" : action, action });
    load();
  };

  return (
    <div className="space-y-2">
      {reports.map((r) => (
        <div key={r.id} className="p-3 border rounded-xl space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-amber-600 border-amber-500/50">{t[r.category as "spam"] || r.category}</Badge>
            <Badge variant="outline">{r.targetType}</Badge>
            <span className="text-xs text-muted-foreground" dir="ltr">{r.targetId.slice(0, 14)}…</span>
            <span className="text-xs text-muted-foreground ms-auto">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => resolve(r, "none")}>{t.dismiss}</Button>
            {r.targetType === "message" && (
              <Button size="sm" variant="outline" className="text-red-500" onClick={() => resolve(r, "delete_message")}>
                {t.deleteMessage}
              </Button>
            )}
            <Button size="sm" variant="outline" className="text-red-500" onClick={() => resolve(r, "ban_user")}>
              {t.ban} {r.targetType === "user" ? "" : "(owner)"}
            </Button>
          </div>
        </div>
      ))}
      {reports.length === 0 && <p className="text-center text-sm text-muted-foreground p-6">✓ {t.noResults}</p>}
    </div>
  );
}

function ChatsTab() {
  const t = useT();
  const [chats, setChats] = useState<Array<{ id: string; type: string; title: string; memberCount: number; _count: { messages: number } }>>([]);
  useEffect(() => { get<Array<{ id: string; type: string; title: string; memberCount: number; _count: { messages: number } }>>("admin/chats").then(setChats).catch(() => undefined); }, []);
  const typeBadge = (ty: string) => (ty === "channel" ? "bg-amber-500/15 text-amber-600" : ty === "group" ? "bg-teal-500/15 text-teal-600" : "bg-muted");
  return (
    <div className="space-y-2">
      {chats.map((c) => (
        <div key={c.id} className="flex items-center gap-2 p-3 border rounded-xl">
          <Badge className={`border-0 ${typeBadge(c.type)}`}>{c.type}</Badge>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{c.title || "—"}</p>
            <p className="text-xs text-muted-foreground">{c.memberCount} {t.members} · {c._count.messages} {t.messages}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditTab() {
  const t = useT();
  const [logs, setLogs] = useState<AuditRow[]>([]);
  useEffect(() => { get<AuditRow[]>("admin/audit-logs?limit=200").then(setLogs).catch(() => undefined); }, []);
  return (
    <div className="space-y-1 font-mono text-xs">
      {logs.map((l) => (
        <div key={l.id} className="flex gap-2 p-2 border-b border-border/50">
          <span className="text-muted-foreground shrink-0">{new Date(l.createdAt).toLocaleString()}</span>
          <Badge variant="outline" className="shrink-0">{l.actorType}</Badge>
          <span className={l.action.includes("failed") || l.action.includes("ban") ? "text-red-500" : "text-teal-600"}>{l.action}</span>
          <span className="text-muted-foreground truncate" dir="ltr">{l.targetId ? `→ ${l.targetId.slice(0, 12)}` : ""}</span>
        </div>
      ))}
    </div>
  );
}
