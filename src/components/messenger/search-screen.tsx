"use client";
// Global search (spec screen 10): messages / people / public chats.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { get, post } from "@/lib/client/api";
import { useStore } from "@/lib/client/store";
import { reloadChatList } from "@/lib/client/socket";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, MessageSquare, Users, Globe, Hash } from "lucide-react";
import type { PublicUser } from "./contacts-screen";

interface GlobalResults {
  users: PublicUser[];
  chats: Array<{ id: string; type: string; title: string; username: string | null; memberCount: number; about: string | null }>;
  messages: Array<{ messageId: string; chatId: string; chatTitle: string; chatType: string; text: string | null; createdAt: string }>;
}

export default function SearchScreen() {
  const t = useT();
  const setView = useStore((s) => s.setView);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<GlobalResults | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- conditional reset on query change */
      setRes(null);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      get<GlobalResults>(`search/global?q=${encodeURIComponent(q)}`)
        .then(setRes)
        .catch(() => undefined)
        .finally(() => setBusy(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [q]);

  const openMessage = async (chatId: string) => {
    await reloadChatList().catch(() => undefined);
    useStore.getState().setActiveChat(chatId);
    setView("chat", chatId);
  };

  const joinChat = async (username: string) => {
    const res2 = await post<{ id?: string; status?: string }>(`chats/public/${username}/join`, {});
    if (res2.id) {
      await reloadChatList();
      useStore.getState().setActiveChat(res2.id);
      setView("chat", res2.id);
    }
  };

  const openPrivate = async (userId: string) => {
    const chat = await post<{ id: string }>("chats/private", { userId });
    await reloadChatList();
    useStore.getState().setActiveChat(chat.id);
    setView("chat", chat.id);
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 flex items-center px-3 border-b bg-teal-950 text-teal-50 gap-2">
        <Search className="w-4 h-4" />
        <h1 className="font-bold">{t.search}</h1>
      </header>
      <div className="p-2 border-b">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchPlaceholder} className="h-10" />
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {busy && <p className="p-3 text-center text-sm text-muted-foreground">{t.loading}</p>}
        {res && (
          <div className="divide-y">
            {res.messages.length > 0 && (
              <section className="p-2">
                <p className="text-xs font-semibold text-muted-foreground px-1 pb-1 flex items-center gap-1"><MessageSquare className="w-3 h-3" />{t.messages}</p>
                {res.messages.map((m) => (
                  <button key={m.messageId} onClick={() => openMessage(m.chatId)} className="w-full text-start p-2 rounded-lg hover:bg-muted">
                    <p className="text-xs font-semibold text-teal-600">{m.chatTitle}</p>
                    <p className="text-sm line-clamp-2">{m.text}</p>
                    <p className="text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</p>
                  </button>
                ))}
              </section>
            )}
            {res.users.length > 0 && (
              <section className="p-2">
                <p className="text-xs font-semibold text-muted-foreground px-1 pb-1 flex items-center gap-1"><Users className="w-3 h-3" />{t.people}</p>
                {res.users.map((u) => (
                  <button key={u.id} onClick={() => openPrivate(u.id)} className="w-full text-start p-2 rounded-lg hover:bg-muted flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-teal-600 text-white flex items-center justify-center text-sm font-bold">{u.displayName.charAt(0)}</div>
                    <div>
                      <p className="text-sm font-medium">{u.displayName}</p>
                      {u.username && <p className="text-xs text-muted-foreground" dir="ltr">@{u.username}</p>}
                    </div>
                  </button>
                ))}
              </section>
            )}
            {res.chats.length > 0 && (
              <section className="p-2">
                <p className="text-xs font-semibold text-muted-foreground px-1 pb-1 flex items-center gap-1"><Globe className="w-3 h-3" />{t.publicChats}</p>
                {res.chats.map((c) => (
                  <div key={c.id} className="p-2 rounded-lg hover:bg-muted flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-600 flex items-center justify-center"><Hash className="w-4 h-4" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{c.memberCount} {t.members}{c.username ? ` · @${c.username}` : ""}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => joinChat(c.username!)}>{t.join}</Button>
                  </div>
                ))}
              </section>
            )}
            {res && res.messages.length === 0 && res.users.length === 0 && res.chats.length === 0 && (
              <p className="text-center text-sm text-muted-foreground p-6">{t.noResults}</p>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
