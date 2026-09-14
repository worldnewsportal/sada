"use client";
// Group/channel info (spec screens 13-15): members, roles, invites+QR,
// join requests, settings (owner), leave/delete, moderation actions.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { get, post, patch, del } from "@/lib/client/api";
import { useStore } from "@/lib/client/store";
import { reloadChatList } from "@/lib/client/socket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { UserPicker } from "./chat-list";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft, UserPlus, Link2, QrCode, Trash2, UserMinus, ShieldCheck, UserCheck, LogOut, Copy, Crown, Gavel,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatCard } from "@/lib/server/services/chats.service";
import type { PublicUser } from "./contacts-screen";

interface MemberRow {
  user: PublicUser;
  role: string;
  customTitle: string | null;
  restrictedUntil: Date | null;
}

export default function GroupInfo() {
  const t = useT();
  const viewParam = useStore((s) => s.viewParam);
  const setView = useStore((s) => s.setView);
  const me = useStore((s) => s.me);
  const [chat, setChat] = useState<ChatCard | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [joinReqs, setJoinReqs] = useState<Array<{ id: string; user: PublicUser }>>([]);
  const [invites, setInvites] = useState<Array<{ id: string; code: string; useCount: number }>>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [about, setAbout] = useState("");
  const [username, setUsername] = useState("");
  const [slowMode, setSlowMode] = useState(0);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    if (!viewParam) return;
    get<ChatCard>(`chats/${viewParam}`).then((c) => {
      setChat(c);
      setTitle(c.title);
      setAbout(c.about || "");
      setUsername(c.username || "");
      setSlowMode(c.slowModeSeconds);
    }).catch(() => undefined);
    get<{ items: MemberRow[] }>(`chats/${viewParam}/members?limit=100`).then((r) => setMembers(r.items)).catch(() => undefined);
    get<Array<{ id: string; user: PublicUser }>>(`chats/${viewParam}/join-requests`).then(setJoinReqs).catch(() => undefined);
    get<Array<{ id: string; code: string; useCount: number }>>(`chats/${viewParam}/invites`).then(setInvites).catch(() => undefined);
  }, [viewParam]);

  if (!chat) return <div className="p-6 text-center text-muted-foreground">{t.loading}</div>;

  const isOwner = chat.role === "owner";
  const isAdmin = chat.role === "owner" || chat.role === "admin";
  const inviteUrl = invites[0] ? `${location.origin}/#/chat/invite:${invites[0].code}` : "";

  const saveInfo = async () => {
    await patch(`chats/${chat.id}`, {
      title: title !== chat.title ? title : undefined,
      about: about !== (chat.about || "") ? about : undefined,
      username: username !== (chat.username || "") ? username || null : undefined,
      slowModeSeconds: slowMode !== chat.slowModeSeconds ? slowMode : undefined,
    }).catch(() => undefined);
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 1500);
    get<ChatCard>(`chats/${chat.id}`).then(setChat).catch(() => undefined);
  };

  const createInvite = async () => {
    const inv = await post<{ code: string }>(`chats/${chat.id}/invites`, {}).catch(() => null);
    if (inv) setInvites([{ id: "", code: inv.code, useCount: 0 }, ...invites]);
  };

  const leave = async () => {
    if (!confirm(t.leaveChat + "?")) return;
    await post(`chats/${chat.id}/leave`, {}).catch(() => undefined);
    await reloadChatList();
    setView("chats");
  };

  const removeMember = async (userId: string) => {
    await del(`chats/${chat.id}/members/${userId}`).catch(() => undefined);
    get<{ items: MemberRow[] }>(`chats/${chat.id}/members?limit=100`).then((r) => setMembers(r.items)).catch(() => undefined);
  };

  const setRole = async (userId: string, role: string) => {
    await post(`chats/${chat.id}/members/${userId}/role`, { role }).catch(() => undefined);
    get<{ items: MemberRow[] }>(`chats/${chat.id}/members?limit=100`).then((r) => setMembers(r.items)).catch(() => undefined);
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 flex items-center gap-2 px-3 border-b bg-teal-950 text-teal-50">
        <Button variant="ghost" size="icon" className="text-teal-100" onClick={() => setView("chat", chat.id)} aria-label="back">
          <ArrowLeft className="w-5 h-5 rtl:rotate-180" />
        </Button>
        <h1 className="font-bold">{chat.type === "channel" ? t.channelInfo : t.groupInfo}</h1>
      </header>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-5 max-w-lg mx-auto">
          {/* header card */}
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-teal-400 to-teal-700 text-white flex items-center justify-center text-2xl font-bold">
              {chat.title.charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="font-bold text-lg truncate">{chat.title}</p>
              <p className="text-sm text-muted-foreground">{chat.memberCount} {t.members}{chat.username ? ` · @${chat.username}` : ""}</p>
              {chat.about && <p className="text-xs text-muted-foreground mt-1">{chat.about}</p>}
            </div>
          </div>

          {/* edit (owner/admin) */}
          {isAdmin && (
            <section className="space-y-2 border rounded-xl p-3">
              <p className="text-sm font-semibold flex items-center gap-1"><Gavel className="w-4 h-4" />{t.settings}</p>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.groupTitle} aria-label={t.groupTitle} />
              <Input value={about} onChange={(e) => setAbout(e.target.value)} placeholder={t.about} aria-label={t.about} />
              <Input dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))} placeholder={`${t.publicLink} (a-z_0-9)`} aria-label={t.publicLink} />
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground flex-1">{t.slowMode} (0-3600s)</Label>
                <Input type="number" min={0} max={3600} value={slowMode} onChange={(e) => setSlowMode(Math.max(0, Math.min(3600, parseInt(e.target.value) || 0)))} className="w-24 h-8" aria-label={t.slowMode} />
              </div>
              <div className="flex items-center gap-2 justify-end">
                {savedMsg && <span className="text-xs text-emerald-600">{t.saved}</span>}
                <Button size="sm" className="bg-teal-600 hover:bg-teal-500" onClick={saveInfo}>{t.save}</Button>
              </div>
            </section>
          )}

          {/* join requests */}
          {joinReqs.length > 0 && (
            <section className="border rounded-xl p-3 space-y-2">
              <p className="text-sm font-semibold flex items-center gap-1"><UserCheck className="w-4 h-4" />{t.joinRequests} ({joinReqs.length})</p>
              {joinReqs.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <span className="flex-1 text-sm truncate">{r.user.displayName}</span>
                  <Button size="sm" variant="outline" className="h-7" onClick={async () => { await post(`join-requests/${r.id}`, { approve: true }); setJoinReqs(joinReqs.filter((x) => x.id !== r.id)); }}>{t.approve}</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={async () => { await post(`join-requests/${r.id}`, { approve: false }); setJoinReqs(joinReqs.filter((x) => x.id !== r.id)); }}>{t.decline}</Button>
                </div>
              ))}
            </section>
          )}

          {/* invites */}
          {(isAdmin || chat.perms.canInviteMembers) && (
            <section className="border rounded-xl p-3 space-y-2">
              <p className="text-sm font-semibold flex items-center gap-1"><Link2 className="w-4 h-4" />{t.inviteLink}</p>
              {inviteUrl && (
                <div className="flex items-center gap-1">
                  <code dir="ltr" className="text-xs bg-muted rounded px-2 py-1 flex-1 truncate">{inviteUrl}</code>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { navigator.clipboard.writeText(inviteUrl); }} aria-label={t.copyLink}><Copy className="w-3.5 h-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setQrOpen(true)} aria-label={t.showQr}><QrCode className="w-4 h-4" /></Button>
                </div>
              )}
              <Button size="sm" variant="outline" onClick={createInvite}>{t.createInvite}</Button>
            </section>
          )}

          {/* members */}
          {chat.type !== "saved" && (
            <section className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <p className="text-sm font-semibold">{t.members}</p>
                {(isAdmin || chat.perms.canInviteMembers) && (
                  <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}><UserPlus className="w-4 h-4 me-1" />{t.addMembers}</Button>
                )}
              </div>
              {members.map((m) => (
                <div key={m.user.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                  <div className="w-9 h-9 rounded-full bg-teal-600 text-white flex items-center justify-center text-sm font-bold">{m.user.displayName.charAt(0)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-1">
                      {m.user.displayName}
                      {m.role === "owner" && <Crown className="w-3 h-3 text-amber-500" />}
                      {(m.role === "admin" || m.role === "moderator") && <ShieldCheck className="w-3 h-3 text-teal-500" />}
                    </p>
                    {m.user.username && <p className="text-xs text-muted-foreground" dir="ltr">@{m.user.username}</p>}
                  </div>
                  {m.role !== "owner" && m.user.id !== me?.id && (
                    <MemberActions
                      canManage={isAdmin}
                      isOwner={isOwner}
                      role={m.role}
                      userId={m.user.id}
                      chatId={chat.id}
                      onRefresh={() => get<{ items: MemberRow[] }>(`chats/${chat.id}/members?limit=100`).then((r) => setMembers(r.items)).catch(() => undefined)}
                      onRemove={() => removeMember(m.user.id)}
                      onSetRole={setRole}
                    />
                  )}
                </div>
              ))}
            </section>
          )}

          <Button variant="destructive" className="w-full" onClick={leave}>
            <LogOut className="w-4 h-4 me-1 rtl:-scale-x-100" /> {t.leaveChat}
          </Button>
        </div>
      </ScrollArea>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t.addMembers}</DialogTitle></DialogHeader>
          <UserPicker
            selected={[]}
            onChange={async (ids) => {
              if (!ids.length) return;
              await post(`chats/${chat.id}/members`, { userIds: ids }).catch(() => undefined);
              setAddOpen(false);
              get<{ items: MemberRow[] }>(`chats/${chat.id}/members?limit=100`).then((r) => setMembers(r.items)).catch(() => undefined);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader><DialogTitle>{t.showQr}</DialogTitle></DialogHeader>
          <div className="flex justify-center p-4 bg-white rounded-xl">
            {inviteUrl && <QRCodeSVG value={inviteUrl} size={200} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MemberActions({
  canManage, isOwner, role, userId, chatId, onRefresh, onRemove, onSetRole,
}: {
  canManage: boolean;
  isOwner: boolean;
  role: string;
  userId: string;
  chatId: string;
  onRefresh: () => void;
  onRemove: () => void;
  onSetRole: (userId: string, role: string) => void;
}) {
  const t = useT();
  if (!canManage) return null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" aria-label="member actions">
          <UserMinus className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t.members}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          {isOwner && (
            <>
              <Button variant="outline" className="w-full" onClick={() => { onSetRole(userId, "admin"); onRefresh(); }}>{t.makeAdmin}</Button>
              <Button variant="outline" className="w-full" onClick={() => { onSetRole(userId, "moderator"); onRefresh(); }}>{t.makeModerator}</Button>
            </>
          )}
          {role !== "member" && (
            <Button variant="outline" className="w-full" onClick={() => { onSetRole(userId, "member"); onRefresh(); }}>{t.demote}</Button>
          )}
          <Button variant="destructive" className="w-full" onClick={async () => { await post(`chats/${chatId}/members/${userId}/restrict`, { days: 1 }).catch(() => undefined); onRefresh(); }}>
            {t.restrictMember} (1d)
          </Button>
          <Button variant="destructive" className="w-full" onClick={() => { onRemove(); onRefresh(); }}>
            <Trash2 className="w-4 h-4 me-1" /> {t.removeMember}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
