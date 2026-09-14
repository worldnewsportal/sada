"use client";
// Contacts (spec screen 9): privacy-preserving sync (hashes only),
// matched users, find-by-username, quick actions.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { get, post } from "@/lib/client/api";
import { reloadChatList } from "@/lib/client/socket";
import { useStore } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { sha256Hex } from "@/lib/client/hash";
import { UserPlus, MessageCircle, Search, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PublicUser {
  id: string;
  displayName: string;
  username: string | null;
  bio: string | null;
  avatarColor?: number;
  lastSeenAt?: string | null;
}

export default function ContactsScreen() {
  const t = useT();
  const setView = useStore((s) => s.setView);
  const [contacts, setContacts] = useState<Array<{ localName: string; user: PublicUser }>>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    get<Array<{ localName: string; user: PublicUser }>>("users/contacts").then(setContacts).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- conditional reset on query change */
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      get<PublicUser[]>(`users/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const syncContacts = async () => {
    try {
      const raw = prompt(t.syncHint + " — one number per line:");
      if (!raw) return;
      const numbers = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 1000);
      const phoneHashes = await Promise.all(numbers.map((n) => sha256Hex(n.startsWith("+") ? n : `+${n}`)));
      await post("users/contacts/sync", { phoneHashes });
      setSynced(true);
      get<Array<{ localName: string; user: PublicUser }>>("users/contacts").then(setContacts).catch(() => undefined);
    } catch {
      /* user cancelled */
    }
  };

  const openPrivate = async (userId: string) => {
    try {
      const chat = await post<{ id: string }>("chats/private", { userId });
      await reloadChatList();
      useStore.getState().setActiveChat(chat.id);
      setView("chat", chat.id);
    } catch {
      /* blocked etc. */
    }
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 flex items-center gap-2 px-3 border-b bg-teal-950 text-teal-50">
        <h1 className="font-bold flex-1">{t.contacts}</h1>
        <Button size="sm" variant="ghost" className="text-teal-100 hover:bg-teal-500/20" onClick={syncContacts}>
          <UserPlus className="w-4 h-4 me-1" /> {t.syncContacts}
        </Button>
      </header>
      {synced && (
        <p className="text-xs text-emerald-600 px-3 py-1.5 flex items-center gap-1">
          <ShieldCheck className="w-3 h-3" /> {t.syncHint}
        </p>
      )}
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.findUsers} className="ps-9 h-9" />
        </div>
      </div>
      <ScrollArea className="flex-1">
        {q.trim().length >= 2 && (
          <section>
            <p className="text-xs font-semibold text-muted-foreground px-3 pt-3 pb-1">{t.people}</p>
            {results.map((u) => (
              <UserRow key={u.id} user={u} onMessage={() => openPrivate(u.id)} />
            ))}
            {results.length === 0 && <p className="text-center text-sm text-muted-foreground p-3">{t.noResults}</p>}
          </section>
        )}
        <section>
          <p className="text-xs font-semibold text-muted-foreground px-3 pt-3 pb-1">{t.contacts}</p>
          {contacts.map((c) => (
            <UserRow key={c.user.id} user={c.user} localName={c.localName} onMessage={() => openPrivate(c.user.id)} />
          ))}
          {contacts.length === 0 && (
            <p className="text-center text-sm text-muted-foreground p-4">{t.syncContacts} → {t.syncHint}</p>
          )}
        </section>
      </ScrollArea>
    </div>
  );
}

function UserRow({ user, localName, onMessage }: { user: PublicUser; localName?: string; onMessage: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-muted/60">
      <Avatar className="w-10 h-10">
        <AvatarFallback className="bg-teal-600 text-white">{user.displayName.charAt(0)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{localName || user.displayName}</p>
        {user.username && <p className="text-xs text-muted-foreground" dir="ltr">@{user.username}</p>}
      </div>
      <Button size="icon" variant="ghost" onClick={onMessage} aria-label={t.message}>
        <MessageCircle className="w-4 h-4 text-teal-600" />
      </Button>
    </div>
  );
}
