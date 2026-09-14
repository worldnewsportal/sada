"use client";
// Chat list (spec screens 5, 25-26): folders, archive, pinned, unread,
// mention badges, search filter, drafts, saved messages, quick actions.
import { useEffect, useState } from "react";
import { useStore } from "@/lib/client/store";
import { useT } from "@/lib/i18n";
import { cn, formatDistanceToNow } from "@/lib/utils";
import { get, post } from "@/lib/client/api";
import { reloadChatList } from "@/lib/client/socket";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  MoreVertical, Archive, Pin, PinOff, ArchiveRestore, VolumeX, Volume2, Trash2,
  Plus, Bookmark, CheckCheck, AtSign, FolderPlus,
} from "lucide-react";
import type { ChatCard } from "@/lib/server/services/chats.service";
import type { Folder } from "@prisma/client";

const AVATAR_GRADIENTS = [
  "from-teal-400 to-teal-600", "from-amber-400 to-amber-600", "from-rose-400 to-rose-600",
  "from-emerald-400 to-emerald-600", "from-violet-400 to-violet-600", "from-cyan-400 to-cyan-600",
  "from-orange-400 to-orange-600", "from-lime-400 to-lime-600",
];

// stable empty reference for Zustand v5 selectors
const EMPTY_TYPING: Record<string, number> = {};

export function ChatAvatar({ chat, size = 44 }: { chat: { title?: string; type?: string; avatarMediaId?: string | null }; size?: number }) {
  const letter = (chat.title || "?").trim().charAt(0).toUpperCase();
  const idx = (chat.title || "").length % AVATAR_GRADIENTS.length;
  return (
    <div
      className={cn("rounded-full bg-gradient-to-br flex items-center justify-center text-white font-bold shrink-0", AVATAR_GRADIENTS[idx])}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden
    >
      {chat.type === "saved" ? <Bookmark className="w-1/2 h-1/2" /> : letter}
    </div>
  );
}

export default function ChatList() {
  const t = useT();
  const chats = useStore((s) => s.chats);
  const loading = useStore((s) => s.chatsLoading);
  const showingArchived = useStore((s) => s.showingArchived);
  const setShowingArchived = useStore((s) => s.setShowingArchived);
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const folderId = useStore((s) => s.folderId);
  const setFolderId = useStore((s) => s.setFolderId);
  const setView = useStore((s) => s.setView);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderDialog, setFolderDialog] = useState(false);

  useEffect(() => {
    reloadChatList().catch(() => undefined);
    get<Folder[]>("folders").then(setFolders).catch(() => undefined);
  }, [showingArchived, folderId, searchQuery]);

  const archivedCount = chats.filter((c) => c.archived).length;

  const openChat = (chatId: string) => {
    useStore.getState().setActiveChat(chatId);
    setView("chat", chatId);
  };

  return (
    <div className="h-full flex flex-col">
      {/* header */}
      <header className="p-3 border-b bg-teal-950 text-teal-50 flex items-center gap-2">
        <h1 className="font-bold text-lg flex-1 px-1">{showingArchived ? t.archivedChats : t.appName}</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-teal-100 hover:bg-teal-500/20" aria-label={t.newChat}>
              <Plus className="w-5 h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFolderDialog(true)}>
              <FolderPlus className="w-4 h-4 me-2" /> {t.newFolder}
            </DropdownMenuItem>
            <NewChatMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* search */}
      <div className="p-2 border-b">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          className="h-9"
          aria-label={t.search}
        />
      </div>

      {/* folders */}
      {folders.length > 0 && !showingArchived && (
        <div className="flex gap-1 px-2 py-1.5 border-b overflow-x-auto" role="tablist">
          <button
            onClick={() => { setFolderId(null); reloadChatList().catch(() => undefined); }}
            className={cn("px-3 py-1 rounded-full text-xs whitespace-nowrap", !folderId ? "bg-teal-500/20 text-teal-600 dark:text-teal-300" : "text-muted-foreground hover:bg-muted")}
            role="tab"
          >
            {t.allChats}
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              onClick={() => { setFolderId(f.id); reloadChatList().catch(() => undefined); }}
              className={cn("px-3 py-1 rounded-full text-xs whitespace-nowrap", folderId === f.id ? "bg-teal-500/20 text-teal-600 dark:text-teal-300" : "text-muted-foreground hover:bg-muted")}
              role="tab"
            >
              {f.icon} {f.name}
            </button>
          ))}
          {archivedCount > 0 && (
            <button
              onClick={() => setShowingArchived(true)}
              className="px-3 py-1 rounded-full text-xs whitespace-nowrap text-muted-foreground hover:bg-muted"
            >
              <Archive className="w-3 h-3 inline me-1" /> {t.archivedChats} ({archivedCount})
            </button>
          )}
        </div>
      )}

      {/* list */}
      <ScrollArea className="flex-1">
        <div role="list">
          {loading && <p className="p-4 text-center text-muted-foreground text-sm">{t.loading}</p>}
          {!loading && chats.length === 0 && (
            <div className="p-8 text-center space-y-2 text-muted-foreground">
              <p className="font-medium">{t.noChats}</p>
              <p className="text-sm">{t.startFirstChat}</p>
              <Button size="sm" className="bg-teal-600 hover:bg-teal-500" onClick={() => setView("contacts")}>
                {t.contacts}
              </Button>
            </div>
          )}
          {chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} onOpen={() => openChat(chat.id)} />
          ))}
        </div>
      </ScrollArea>

      <NewFolderDialog open={folderDialog} onClose={() => setFolderDialog(false)} />
    </div>
  );
}

function ChatRow({ chat, onOpen }: { chat: ChatCard; onOpen: () => void }) {
  const t = useT();
  const me = useStore((s) => s.me);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const typingMap = useStore((s) => s.typing[chat.id]) ?? EMPTY_TYPING;
  const isTyping = Object.keys(typingMap).filter((u) => u !== me?.id).length > 0;
  const muted = chat.mutedUntil && chat.mutedUntil > new Date();

  const preview =
    chat.type === "saved" && !chat.lastMsgPreview
      ? t.savedChatDesc
      : chat.lastMsgPreview
        ? `${chat.lastMsgPreview.senderName && chat.type !== "private" ? chat.lastMsgPreview.senderName + ": " : ""}${chat.lastMsgPreview.text || ""}`
        : "";

  return (
    <div role="listitem" className="group relative">
      <button
        onClick={onOpen}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 text-start hover:bg-muted/70 transition-colors border-b border-border/40",
          useStore.getState().activeChatId === chat.id && "bg-teal-500/10"
        )}
      >
        <div className="relative">
          <ChatAvatar chat={chat} />
          {chat.type === "private" && onlineUsers.has(chat.peer?.id || "") && (
            <span className="absolute bottom-0 end-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-background" aria-label={t.online} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {chat.pinned && <Pin className="w-3 h-3 text-teal-500 shrink-0" />}
            <p className="font-semibold text-sm truncate flex-1">{chat.title}</p>
            {chat.lastMessageAt && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatDistanceToNow(new Date(chat.lastMessageAt), true)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground truncate flex-1">
              {isTyping ? <span className="text-teal-500 font-medium">{t.typing}</span> : preview}
            </p>
            {chat.mentionCount > 0 && (
              <Badge className="bg-amber-500/20 text-amber-600 dark:text-amber-400 border-0 shrink-0">
                <AtSign className="w-3 h-3" />
              </Badge>
            )}
            {chat.unreadCount > 0 && (
              <Badge className={cn("shrink-0 border-0", muted ? "bg-muted text-muted-foreground" : "bg-teal-600 text-white")}>
                {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
              </Badge>
            )}
            {muted && <VolumeX className="w-3 h-3 text-muted-foreground shrink-0" />}
          </div>
        </div>
      </button>
      <ChatRowMenu chat={chat} />
    </div>
  );
}

function ChatRowMenu({ chat }: { chat: ChatCard }) {
  const t = useT();
  const refresh = () => reloadChatList().catch(() => undefined);

  const act = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
    refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 h-8 w-8"
          aria-label="chat menu"
        >
          <MoreVertical className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => act(() => post(`chats/${chat.id}/flags`, { pinned: !chat.pinned }))}>
          {chat.pinned ? <PinOff className="w-4 h-4 me-2" /> : <Pin className="w-4 h-4 me-2" />}
          {chat.pinned ? t.unpin : t.pin}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => post(`chats/${chat.id}/flags`, { archived: !chat.archived }))}>
          {chat.archived ? <ArchiveRestore className="w-4 h-4 me-2" /> : <Archive className="w-4 h-4 me-2" />}
          {chat.archived ? t.unarchive : t.archivedChats}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => act(() => post(`chats/${chat.id}/flags`, { mutedUntil: chat.mutedUntil && chat.mutedUntil > new Date() ? null : new Date(Date.now() + 365 * 86400_000).toISOString() }))}>
          {chat.mutedUntil && chat.mutedUntil > new Date() ? <Volume2 className="w-4 h-4 me-2" /> : <VolumeX className="w-4 h-4 me-2" />}
          {chat.mutedUntil && chat.mutedUntil > new Date() ? t.unmute : t.mute}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={() => act(() => fetch(`/api/v1/chats/${chat.id}`, { method: "DELETE", credentials: "include" }))}>
          <Trash2 className="w-4 h-4 me-2" /> {t.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NewChatMenuItems() {
  const t = useT();
  const setView = useStore((s) => s.setView);
  const [dialog, setDialog] = useState<"private" | "group" | "channel" | "saved" | null>(null);
  return (
    <>
      <DropdownMenuItem onClick={() => setDialog("private")}>{t.newChat}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDialog("group")}>{t.newGroup}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDialog("channel")}>{t.newChannel}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => setDialog("saved")}>
        <Bookmark className="w-4 h-4 me-2" /> {t.savedMessages}
      </DropdownMenuItem>
      <CreateChatDialog mode={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

export function CreateChatDialog({ mode, onClose }: { mode: "private" | "group" | "channel" | "saved" | null; onClose: () => void }) {
  const t = useT();
  const setView = useStore((s) => s.setView);
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [about, setAbout] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; displayName: string; username: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);

  useEffect(() => {
    if (mode && mode !== "saved") {
      get<Array<{ id: string; displayName: string; username: string | null }>>("users/search?q=").catch(() => setUsers([]));
    }
  }, [mode]);

  useEffect(() => {
    if (mode) {
      setTitle("");
      setUsername("");
      setAbout("");
      setSelected([]);
      setError("");
    }
  }, [mode]);

  if (!mode) return null;

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      let chatId: string | null = null;
      if (mode === "saved") {
        const chat = await post<ChatCard>("chats/saved", {});
        chatId = chat.id;
      } else if (mode === "private") {
        if (!selected[0]) throw new Error(t.selectUsers);
        const chat = await post<ChatCard>("chats/private", { userId: selected[0] });
        chatId = chat.id;
      } else {
        const res = await post<ChatCard & { status?: string }>(`chats/${mode}`, {
          title: title.trim(),
          about: about || undefined,
          memberIds: mode === "group" ? selected : [],
          isPublic: !!username,
          username: username || undefined,
          requireApproval: mode === "group" ? requireApproval : undefined,
        });
        chatId = res.id;
      }
      onClose();
      await reloadChatList();
      if (chatId) {
        useStore.getState().setActiveChat(chatId);
        setView("chat", chatId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!mode} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "group" ? t.newGroup : mode === "channel" ? t.newChannel : mode === "saved" ? t.savedMessages : t.newChat}
          </DialogTitle>
        </DialogHeader>

        {mode === "saved" ? (
          <p className="text-sm text-muted-foreground">{t.savedChatDesc}</p>
        ) : mode === "private" ? (
          <UserPicker selected={selected} onChange={setSelected} single />
        ) : (
          <div className="space-y-3">
            <Input placeholder={mode === "group" ? t.groupTitle : t.channelTitle} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="title" />
            <Input placeholder={t.about} value={about} onChange={(e) => setAbout(e.target.value)} aria-label={t.about} />
            <Input
              dir="ltr"
              placeholder={`${t.publicLink}: mylink (a-z_0-9)`}
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32))}
              aria-label={t.publicLink}
            />
            {mode === "group" && (
              <div className="flex items-center gap-2">
                <Switch id="approval" checked={requireApproval} onCheckedChange={setRequireApproval} />
                <Label htmlFor="approval">{t.joinRequests}</Label>
              </div>
            )}
            <div className="text-xs text-muted-foreground">{t.selectUsers}</div>
            <UserPicker selected={selected} onChange={setSelected} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
          <Button className="bg-teal-600 hover:bg-teal-500" disabled={busy} onClick={create}>
            {busy ? t.loading : t.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UserPicker({
  selected,
  onChange,
  single,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; displayName: string; username: string | null; avatarColor?: number }>>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      get<Array<{ id: string; displayName: string; username: string | null }>>(`users/search?q=${encodeURIComponent(q)}`)
        .then(setUsers)
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const toggle = (id: string) => {
    if (single) onChange([id]);
    else onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div className="space-y-2">
      <Input placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} className="h-9" />
      <ScrollArea className="max-h-64">
        {users.map((u) => (
          <button
            key={u.id}
            onClick={() => toggle(u.id)}
            className={cn(
              "w-full flex items-center gap-2 p-2 rounded-lg text-start hover:bg-muted",
              selected.includes(u.id) && "bg-teal-500/15"
            )}
          >
            <ChatAvatar chat={{ title: u.displayName }} size={36} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{u.displayName}</p>
              {u.username && <p className="text-xs text-muted-foreground" dir="ltr">@{u.username}</p>}
            </div>
            {selected.includes(u.id) && <CheckCheck className="w-4 h-4 text-teal-500" />}
          </button>
        ))}
        {users.length === 0 && <p className="text-center text-sm text-muted-foreground p-3">{t.noResults}</p>}
      </ScrollArea>
    </div>
  );
}

export function NewFolderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const setFolderId = useStore((s) => s.setFolderId);

  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t.newFolder}</DialogTitle></DialogHeader>
        <Input placeholder={t.folderName} value={name} onChange={(e) => setName(e.target.value.slice(0, 32))} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
          <Button
            className="bg-teal-600 hover:bg-teal-500"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              await post("folders", { name: name.trim() }).catch(() => undefined);
              setBusy(false);
              setName("");
              onClose();
            }}
          >
            {t.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
