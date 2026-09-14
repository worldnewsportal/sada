"use client";
// Main shell: nav rail (mobile BOTTOM bar / desktop side rail) + active view.
// Mobile: the nav sits at the bottom (thumb-reachable), and the top of the
// chats screen holds ONLY the search field. A FAB (in ChatList) covers
// "new chat". Desktop (md+): unchanged vertical side rail.
import { useStore } from "@/lib/client/store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import ChatList from "./chat-list";
import ChatView from "./chat-view";
import SettingsScreen from "./settings-screen";
import ContactsScreen from "./contacts-screen";
import SearchScreen from "./search-screen";
import GroupInfo from "./group-info";
import AdminPanel from "./admin-panel";
import MediaViewer from "./media-viewer";
import CallOverlay from "./call-overlay";
import { MessageSquare, Users, Settings, Search, Shield, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function MainShell() {
  const t = useT();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const activeChatId = useStore((s) => s.activeChatId);
  const connectionState = useStore((s) => s.connectionState);
  const me = useStore((s) => s.me);
  // total unread across chats → badge on the bottom-bar chats item
  const totalUnread = useStore((s) => s.chats.reduce((n, c) => n + (c.archived ? 0 : c.unreadCount), 0));

  return (
    <div className="h-full flex flex-col md:flex-row bg-background" dir="auto">
      {/* nav — mobile: BOTTOM bar; desktop: side rail (order-first) */}
      <nav
        className={cn(
          // mobile bottom bar
          "fixed inset-x-0 bottom-0 z-40 h-16 md:h-auto md:static",
          "flex md:flex-col items-center justify-around md:justify-start md:gap-2",
          "border-t md:border-t-0 md:border-e bg-teal-950 text-teal-100",
          "pb-[env(safe-area-inset-bottom)] md:pb-0 md:py-4 md:w-16",
          view === "chat" && "hidden md:flex"
        )}
        aria-label="main navigation"
      >
        <NavItem icon={<MessageSquare className="w-5 h-5" />} label={t.chats} active={view === "chats"} badge={totalUnread > 0 ? Math.min(totalUnread, 99) : 0} onClick={() => setView("chats")} />
        <NavItem icon={<Users className="w-5 h-5" />} label={t.contacts} active={view === "contacts"} onClick={() => setView("contacts")} />
        <NavItem icon={<Search className="w-5 h-5" />} label={t.search} active={view === "search"} onClick={() => setView("search")} />
        <NavItem icon={<Settings className="w-5 h-5" />} label={t.settings} active={view === "settings"} onClick={() => setView("settings")} />
        <NavItem icon={<Shield className="w-5 h-5" />} label={t.adminPanel} active={view === "admin"} onClick={() => setView("admin")} />
      </nav>

      {/* primary pane — extra bottom padding on mobile so the bar never covers content */}
      <section className={cn("flex-1 min-w-0 h-full pb-16 md:pb-0", view === "chat" && "hidden md:block")}>
        {view === "chats" && <ChatList />}
        {view === "contacts" && <ContactsScreen />}
        {view === "search" && <SearchScreen />}
        {view === "settings" && <SettingsScreen />}
        {view === "admin" && <AdminPanel />}
      </section>

      {/* chat pane (desktop: side-by-side; mobile: fullscreen) */}
      <section className={cn("flex-1 min-w-0 h-full", view !== "chat" && "hidden md:block")}>
        {activeChatId ? (
          <ChatView />
        ) : (
          <div className="h-full hidden md:flex items-center justify-center text-muted-foreground bg-muted/30">
            <div className="text-center space-y-2">
              <MessageSquare className="w-12 h-12 mx-auto opacity-30" />
              <p>{t.selectChat}</p>
            </div>
          </div>
        )}
      </section>

      {/* mobile back button overlay when in chat */}
      {view === "chat" && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-2 start-2 z-40 md:hidden rounded-full bg-background/80"
          onClick={() => setView("chats")}
          aria-label="back"
        >
          <ArrowLeft className="w-5 h-5 rtl:rotate-180" />
        </Button>
      )}

      {view === "group-info" && <GroupInfo />}
      {view === "media-viewer" && <MediaViewer />}
      <CallOverlay />

      {/* connection banner */}
      {connectionState === "offline" && (
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-amber-950 text-xs text-center py-1 font-medium">
          {t.offlineBanner}
        </div>
      )}
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  badge = 0,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex flex-col md:flex-row items-center gap-0.5 md:gap-1 px-3 py-1.5 md:py-2 rounded-xl transition-colors min-h-[44px] min-w-[52px] md:min-w-0",
        active ? "bg-teal-500/20 text-teal-300" : "hover:bg-teal-500/10 text-teal-200/70"
      )}
      aria-label={label}
      aria-current={active}
    >
      {icon}
      <span className="text-[10px] md:hidden leading-none">{label}</span>
      {badge > 0 && (
        <span
          className="absolute top-0.5 end-1 md:end-0 md:top-1 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-teal-950 text-[10px] font-bold flex items-center justify-center"
          aria-label={`${badge} unread`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
