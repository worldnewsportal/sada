import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Sada — صدى | Secure Messenger",
  description:
    "Sada (صدى) — production-grade real-time messenger: private chats, groups, channels, media, voice messages, calls, offline sync and end-to-end architecture.",
  keywords: ["messenger", "chat", "Sada", "صدى", "secure messaging"],
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Sada" },
};

export const viewport: Viewport = {
  themeColor: "#0f766e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground h-dvh overflow-hidden">
        <ToastProvider>{children}</ToastProvider>
        <Toaster />
      </body>
    </html>
  );
}
