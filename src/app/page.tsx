// ============================================================
// Sada — root shell. The entire messenger lives under "/" as a
// single-page app (the sandbox exposes only this route):
// splash → auth → chat list ⇄ chat view ⇄ settings ⇄ admin …
// ============================================================
"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/client/store";
import { I18nProvider } from "@/lib/i18n";
import { get } from "@/lib/client/api";
import {
  connectRealtime,
  disconnectRealtime,
  reloadChatList,
  startOutboxTimer,
  reconcile,
} from "@/lib/client/socket";
import { registerServiceWorker, subscribeToPush } from "@/lib/client/push";
import { ThemeProvider } from "next-themes";

import AuthScreen from "@/components/messenger/auth-screen";
import MainShell from "@/components/messenger/main-shell";

export default function Home() {
  const me = useStore((s) => s.me);
  const authChecked = useStore((s) => s.authChecked);
  const setMe = useStore((s) => s.setMe);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      // 1. session probe
      try {
        const profile = await get<Record<string, unknown>>("users/me");
        setMe(profile as never);
      } catch {
        setMe(null);
      }

      // 2. realtime + outbox + push
      await registerServiceWorker();
      startOutboxTimer();
    })();
  }, [setMe]);

  useEffect(() => {
    if (me) {
      connectRealtime();
      reloadChatList().catch(() => undefined);
      reconcile().catch(() => undefined);
      subscribeToPush().catch(() => undefined);
      // hash deep-links (#/chat/<id>, #/admin) — spec §75
      const hash = location.hash;
      if (hash.startsWith("#/chat/")) {
        useStore.getState().setView("chat", hash.replace("#/chat/", ""));
      } else if (hash.startsWith("#/admin")) {
        useStore.getState().setView("admin");
      }
    } else if (authChecked) {
      disconnectRealtime();
    }
  }, [me, authChecked]);

  return (
    <I18nProvider>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <main className="h-dvh w-full overflow-hidden bg-background text-foreground">
          {!authChecked ? (
            <SplashScreen />
          ) : me ? (
            <MainShell />
          ) : (
            <AuthScreen />
          )}
        </main>
      </ThemeProvider>
    </I18nProvider>
  );
}

function SplashScreen() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-teal-950 to-teal-900 text-teal-50">
      <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-teal-400 to-teal-700 flex items-center justify-center shadow-2xl shadow-teal-900/50 animate-pulse">
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
          <path d="M10 22 v0" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
          <path d="M17 15 v14" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
          <path d="M24 10 v24" stroke="#fbbf24" strokeWidth="5" strokeLinecap="round" />
          <path d="M31 15 v14" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
          <path d="M38 19 v6" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-lg font-bold tracking-wide">صدى · Sada</p>
      <p className="text-xs text-teal-300/70">secure messenger</p>
    </div>
  );
}
