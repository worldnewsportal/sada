"use client";
// Signed media URL resolution — HMAC stays server-side; the client either
// uses urls embedded in message DTOs or asks media/signed for ad-hoc media.
const cache = new Map<string, { url: string; exp: number }>();

export async function resolveMediaUrl(mediaId: string, variant = "original"): Promise<string | null> {
  if (!mediaId) return null;
  const key = `${mediaId}.${variant}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return hit.url;
  try {
    const { get } = await import("./api");
    const res = await get<{ url: string }>(`media/signed?m=${encodeURIComponent(mediaId)}&v=${variant}`);
    cache.set(key, { url: res.url, exp: Date.now() + 12 * 60_000 });
    return res.url;
  } catch {
    return null;
  }
}
