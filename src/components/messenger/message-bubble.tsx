"use client";
// Message bubble (spec UI list): reply preview, reactions, edited flag,
// delivery/read status, timestamps, forwarded header, media/voice/file
// cards, scheduled + pending + failed + deleted states, system messages.
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useStore } from "@/lib/client/store";
import { useSignedMedia } from "@/lib/client/use-signed-media";
import { post, del } from "@/lib/client/api";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CheckCheck, Check, Clock, AlertCircle, Download, Play, Pause, Pin, SmilePlus, Copy, CornerUpLeft, Forward, Pencil, Trash2, UserX, Flag } from "lucide-react";
import type { MessageDTO } from "@/lib/server/services/messages.service";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

function formatTime(iso: string, locale: string) {
  return new Date(iso).toLocaleTimeString(locale === "ar" ? "ar-IQ" : "en-US", { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({
  msg,
  prev,
  chatType,
  onReply,
  onEdit,
  onOpenMedia,
}: {
  msg: MessageDTO;
  prev?: MessageDTO;
  chatType: string;
  onReply: (msg: MessageDTO) => void;
  onEdit: (msg: MessageDTO) => void;
  onOpenMedia: (mediaId: string, variant?: string) => void;
}) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const me = useStore((s) => s.me);
  const chatId = msg.chatId;
  const mine = msg.sender?.id === me?.id;

  // system message
  if (msg.kind === "system") {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">{msg.text}</span>
      </div>
    );
  }

  const pending = msg.status === "pending";
  const scheduled = msg.status === "scheduled";
  const deleted = msg.status === "deleted";
  const failed = pending && (msg as unknown as { failed?: boolean }).failed;
  const showDaySep = !prev || new Date(prev.createdAt).toDateString() !== new Date(msg.createdAt).toDateString();
  const dayLabel = formatDay(msg.createdAt, locale);

  return (
    <>
      {showDaySep && (
        <div className="flex justify-center my-3">
          <span className="text-[11px] text-muted-foreground bg-muted px-3 py-1 rounded-full">{dayLabel}</span>
        </div>
      )}
      <div className={cn("flex w-full group px-2", mine ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[85%] md:max-w-[70%] flex flex-col", mine ? "items-end" : "items-start")}>
          {/* sender name in groups */}
          {!mine && chatType !== "private" && chatType !== "saved" && (
            <span className="text-xs font-semibold text-teal-600 dark:text-teal-400 mb-0.5 ms-1">
              {msg.sender?.displayName || "—"}
            </span>
          )}

          {/* forwarded header */}
          {msg.forwardOriginName && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-0.5">
              <Forward className="w-3 h-3" />
              {t.forward} · {msg.forwardOriginName}
            </div>
          )}

          <div
            className={cn(
              "relative rounded-2xl px-3 py-1.5 shadow-sm",
              mine
                ? "bg-teal-600 text-white rounded-ee-md"
                : "bg-muted text-foreground rounded-es-md",
              deleted && "italic opacity-60 border border-dashed",
              pending && "opacity-70"
            )}
          >
            {/* reply preview */}
            {msg.replyTo && !deleted && (
              <div className={cn("border-s-2 ps-2 mb-1 text-xs rounded", mine ? "border-amber-300 bg-black/10 py-0.5" : "border-teal-500 bg-background/60 py-0.5")}>
                <p className="font-semibold text-[11px]">{msg.replyTo.senderName}</p>
                <p className="line-clamp-2 opacity-80">{msg.replyTo.text || "📎"}</p>
              </div>
            )}

            {deleted ? (
              <p className="text-sm py-0.5">{t.deletedMessage}</p>
            ) : (
              <>
                {/* attachments */}
                {msg.attachments?.length > 0 && <Attachments msg={msg} onOpenMedia={onOpenMedia} mine={mine} />}

                {/* sticker */}
                {msg.attachments?.[0]?.kind === "sticker" ? null : (
                  <>
                    {msg.text && (
                      <p className="text-sm whitespace-pre-wrap break-words leading-relaxed py-0.5" dir="auto">
                        {renderEntities(msg.text, msg.entities)}
                      </p>
                    )}
                  </>
                )}

                {/* meta row */}
                <div className={cn("flex items-center gap-1 justify-end text-[10px] mt-0.5", mine ? "text-white/70" : "text-muted-foreground")}>
                  {msg.isPinned && <Pin className="w-3 h-3" />}
                  {msg.editedAt && <span title={t.edited}>{t.edited}</span>}
                  {scheduled ? (
                    <><Clock className="w-3 h-3" /><span>{t.scheduled}</span></>
                  ) : (
                    <span>{formatTime(msg.createdAt, locale)}</span>
                  )}
                  {mine && !scheduled && !pending && (
                    msg.readByCount && msg.readByCount > 1 ? <CheckCheck className="w-3.5 h-3.5 text-amber-300" /> : <Check className="w-3.5 h-3.5" />
                  )}
                  {pending && !failed && <Clock className="w-3 h-3 animate-pulse" />}
                  {failed && <AlertCircle className="w-3 h-3 text-red-300" />}
                </div>
              </>
            )}
          </div>

          {/* reactions row */}
          {msg.reactions?.length > 0 && !deleted && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {msg.reactions.map((r) => (
                <button
                  key={r.emoji}
                  onClick={() => post(`messages/${msg.id}/reactions`, { emoji: r.emoji })}
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded-full border transition-colors",
                    r.mine ? "border-teal-500 bg-teal-500/15" : "border-border bg-background hover:bg-muted"
                  )}
                  aria-label={`${r.emoji} ${r.count}`}
                >
                  {r.emoji} {r.count > 1 && <span className="text-[10px] font-bold">{r.count}</span>}
                </button>
              ))}
            </div>
          )}

          {/* actions row (hover) */}
          {!deleted && !pending && !scheduled && (
            <div className={cn("flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity", mine && "flex-row-reverse")}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t.reactions}>
                    <SmilePlus className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2 flex gap-1" side="top">
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      className="text-lg hover:scale-125 transition-transform"
                      onClick={() => post(`messages/${msg.id}/reactions`, { emoji: e })}
                    >
                      {e}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
              <MessageActions msg={msg} mine={mine} onReply={onReply} onEdit={onEdit} />
            </div>
          )}
          {failed && (
            <button className="text-xs text-destructive mt-1 flex items-center gap-1" onClick={() => useStore.getState().removeFromOutbox(msg.id)}>
              <Trash2 className="w-3 h-3" /> {t.delete}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function MessageActions({ msg, mine, onReply, onEdit }: { msg: MessageDTO; mine: boolean; onReply: (m: MessageDTO) => void; onEdit: (m: MessageDTO) => void }) {
  const t = useT();
  const chatId = msg.chatId;
  const activeChat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const canPin = activeChat?.perms?.canPinMessages;
  const canDelete = mine || activeChat?.perms?.canDeleteMessages;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="message actions">
          <span className="text-muted-foreground text-lg leading-none">⋯</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={mine ? "end" : "start"}>
        <DropdownMenuItem onClick={() => onReply(msg)}><CornerUpLeft className="w-4 h-4 me-2" />{t.reply}</DropdownMenuItem>
        {msg.text && (
          <DropdownMenuItem onClick={() => navigator.clipboard.writeText(msg.text || "")}><Copy className="w-4 h-4 me-2" />{t.copy}</DropdownMenuItem>
        )}
        {mine && msg.kind === "text" && !msg.forwardFromMsgId && (
          <DropdownMenuItem onClick={() => onEdit(msg)}><Pencil className="w-4 h-4 me-2" />{t.editMessage}</DropdownMenuItem>
        )}
        {canPin && (
          <DropdownMenuItem onClick={() => post(`messages/${msg.id}/pin`, { pinned: !msg.isPinned })}>
            <Pin className="w-4 h-4 me-2" />{msg.isPinned ? t.unpin : t.pin}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem className="text-destructive" onClick={() => del(`messages/${msg.id}`)}>
            <Trash2 className="w-4 h-4 me-2" />{t.deleteMessage}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={() => post("reports", { targetType: "message", targetId: msg.id, category: "other" })}>
          <Flag className="w-4 h-4 me-2" />{t.report}
        </DropdownMenuItem>
        {!mine && msg.sender && (
          <DropdownMenuItem className="text-destructive" onClick={() => post(`users/${msg.sender!.id}/block`, {})}>
            <UserX className="w-4 h-4 me-2" />{t.block}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Attachments({ msg, onOpenMedia, mine }: { msg: MessageDTO; onOpenMedia: (id: string, v?: string) => void; mine: boolean }) {
  const att = msg.attachments[0];

  if (!att) return null;
  const meta = (att.meta || {}) as Record<string, unknown>;

  if (att.kind === "sticker") {
    return (
      <div className="text-6xl leading-none p-1">{(meta.emoji as string) || "✨"}</div>
    );
  }
  if (att.kind === "image" || att.kind === "gif") {
    return <SignedImage mediaId={att.mediaId} filename={att.filename} onOpenMedia={onOpenMedia} />;
  }
  if (att.kind === "video") {
    return <SignedVideo mediaId={att.mediaId} />;
  }
  if (att.kind === "voice" || att.kind === "audio") {
    return <VoicePlayer mediaId={att.mediaId!} duration={Number(meta.durationMs || 0)} peaks={(meta.peaks as number[]) || []} mine={mine} />;
  }
  // document
  return <FileCard att={att} />;
}

function SignedImage({ mediaId, filename, onOpenMedia }: { mediaId: string | null; filename: string | null; onOpenMedia: (id: string, v?: string) => void }) {
  const thumb = useSignedMedia(mediaId, "thumb");
  const original = useSignedMedia(mediaId, "original");
  return (
    <button onClick={() => mediaId && onOpenMedia(mediaId)} className="block" disabled={!thumb}>
      <img
        src={thumb || original || ""}
        alt={filename || "image"}
        loading="lazy"
        className="max-w-[240px] max-h-[300px] rounded-xl object-cover"
      />
    </button>
  );
}

function SignedVideo({ mediaId }: { mediaId: string | null }) {
  const url = useSignedMedia(mediaId, "original");
  const thumb = useSignedMedia(mediaId, "thumb");
  if (!url) return <div className="w-48 h-28 rounded-xl bg-muted animate-pulse" />;
  return <video src={url} controls preload="metadata" className="max-w-[260px] rounded-xl" poster={thumb || undefined} />;
}

function FileCard({ att }: { att: NonNullable<MessageDTO["attachments"]>[number] }) {
  const url = useSignedMedia(att.mediaId, "original");
  const sizeMB = att.size ? (att.size / 1024 / 1024).toFixed(1) : "?";
  return (
    <a
      href={url || "#"}
      download={att.filename || "file"}
      className="flex items-center gap-3 py-2 pe-6 min-w-[180px]"
      target="_blank"
      rel="noreferrer"
    >
      <div className="w-10 h-10 rounded-lg bg-teal-500/20 flex items-center justify-center">
        <Download className="w-5 h-5 text-teal-600" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{att.filename || "file"}</p>
        <p className="text-xs text-muted-foreground">{sizeMB} MB</p>
      </div>
    </a>
  );
}

function VoicePlayer({ mediaId, duration, peaks, mine }: { mediaId: string; duration: number; peaks: number[]; mine: boolean }) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const url = useSignedMedia(mediaId, "original");
  const bars = peaks.length ? peaks : Array.from({ length: 28 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 1.7)));

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    const onEnd = () => { setPlaying(false); setProgress(0); };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
    };
  }, []);

  return (
    <div className="flex items-center gap-2 py-1.5 min-w-[200px]">
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
      <button
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) { audio.pause(); setPlaying(false); }
          else { audio.play().then(() => setPlaying(true)).catch(() => undefined); }
        }}
        className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", mine ? "bg-white/20" : "bg-teal-500/20")}
        aria-label={t.voiceMessage}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ms-0.5" />}
      </button>
      <div className="flex items-end gap-[2px] h-7 flex-1">
        {bars.slice(0, 28).map((h, i) => (
          <div
            key={i}
            className={cn("w-[3px] rounded-full transition-colors", i / bars.length <= progress ? "bg-amber-400" : mine ? "bg-white/40" : "bg-muted-foreground/40")}
            style={{ height: `${Math.max(15, Math.min(100, h * 100))}%` }}
          />
        ))}
      </div>
      <span className="text-[10px] opacity-70 shrink-0">{formatDuration(duration)}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalS = Math.round(ms / 1000) || 0;
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
}

function formatDay(iso: string, locale: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return locale === "ar" ? "اليوم" : "Today";
  if (d.toDateString() === yesterday.toDateString()) return locale === "ar" ? "أمس" : "Yesterday";
  return d.toLocaleDateString(locale === "ar" ? "ar-IQ" : "en-US", { day: "numeric", month: "long" });
}

/** Render text with url entities as links (server-provided offsets). */
function renderEntities(text: string, entities: unknown): React.ReactNode {
  type Ent = { type: string; offset: number; length: number };
  const ents = (Array.isArray(entities) ? entities : []) as Ent[];
  const urlEnts = ents.filter((e) => e.type === "url").sort((a, b) => a.offset - b.offset);
  if (!urlEnts.length) return text;

  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const ent of urlEnts) {
    if (ent.offset > pos) parts.push(text.slice(pos, ent.offset));
    const url = text.slice(ent.offset, ent.offset + ent.length);
    parts.push(
      <a key={ent.offset} href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-amber-400/70 hover:decoration-amber-400 break-all" dir="ltr">
        {url}
      </a>
    );
    pos = ent.offset + ent.length;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}
