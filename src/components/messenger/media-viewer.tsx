"use client";
// Full-screen media viewer (spec screen 11): variants, download, close.
import { useStore } from "@/lib/client/store";
import { useT } from "@/lib/i18n";
import { useSignedMedia } from "@/lib/client/use-signed-media";
import { Button } from "@/components/ui/button";
import { X, Download, Loader2 } from "lucide-react";

export default function MediaViewer() {
  const t = useT();
  const viewParam = useStore((s) => s.viewParam);
  const setView = useStore((s) => s.setView);
  const url = useSignedMedia(viewParam, "original");

  if (!viewParam) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center" role="dialog" aria-modal>
      <div className="absolute top-3 end-3 flex gap-2">
        <a href={url || "#"} download target="_blank" rel="noreferrer">
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" aria-label={t.file}>
            <Download className="w-5 h-5" />
          </Button>
        </a>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => setView("chat")} aria-label={t.close}>
          <X className="w-5 h-5" />
        </Button>
      </div>
      {!url ? (
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      ) : (
        <img src={url} alt="media" className="max-w-full max-h-[90dvh] object-contain" />
      )}
    </div>
  );
}
