"use client";
// Sync signed-urls into DOM imgs: waits for the signed URL then swaps src.
import { useEffect, useState } from "react";
import { resolveMediaUrl } from "./signed-urls";

export function useSignedMedia(mediaId: string | null | undefined, variant = "original"): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // async callback only — no synchronous setState in the effect body
    resolveMediaUrl(mediaId || "", variant).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [mediaId, variant]);
  return url;
}
