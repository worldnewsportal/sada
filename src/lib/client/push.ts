"use client";
// ============================================================
// PWA push + service worker registration (spec §18).
// VAPID web push works out of the box; FCM/APNs adapters server-side.
// ============================================================
import { get, post } from "./api";

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return reg;
  } catch {
    return null;
  }
}

export async function subscribeToPush(): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const reg = await registerServiceWorker();
    if (!reg) return false;

    const { publicKey } = await get<{ publicKey: string }>("notifications/vapid-key");
    if (!publicKey) return false; // push not configured on server — graceful

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      }));

    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await post("notifications/push/subscribe", json);
    return true;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
