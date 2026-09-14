"use client";
// Main shell: nav rail (mobile bottom / desktop side) + active view.
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

  return (
    <div className="h-full flex flex-col md:flex-row bg-background" dir="auto">
      {/* nav rail */}
      <nav
        className={cn(
          "md:w-16 md:h-full flex md:flex-col items-center justify-around md:justify-start md:gap-2 md:py-4 md:order-first",
          "h-14 border-b md:border-b-0 md:border-e bg-teal-950 text-teal-100",
          view === "chat" && "hidden md:flex"
        )}
        aria-label="main navigation"
      >
        <NavItem icon={<MessageSquare className="w-5 h-5" />} label={t.chats} active={view === "chats"} onClick={() => setView("chats")} />
        <NavItem icon={<Users className="w-5 h-5" />} label={t.contacts} active={view === "contacts"} onClick={() => setView("contacts")} />
        <NavItem icon={<Search className="w-5 h-5" />} label={t.search} active={view === "search"} onClick={() => setView("search")} />
        <NavItem icon={<Settings className="w-5 h-5" />} label={t.settings} active={view === "settings"} onClick={() => setView("settings")} />
        {me?.username === null ? null : null}
        <NavItem icon={<Shield className="w-5 h-5" />} label={t.adminPanel} active={view === "admin"} onClick={() => setView("admin")} />
      </nav>

      {/* primary pane */}
      <section className={cn("flex-1 min-w-0 h-full", view === "chat" && "hidden md:block")}>
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

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col md:flex-row items-center gap-1 px-3 py-2 rounded-xl transition-colors min-h-[44px]",
        active ? "bg-teal-500/20 text-teal-300" : "hover:bg-teal-500/10 text-teal-200/70"
      )}
      aria-label={label}
      aria-current={active}
    >
      {icon}
      <span className="text-[10px] md:hidden">{label}</span>
    </button>
  );
}
