"use client";
// Chat view (spec screens 6-8): bubbles, pinned bar, typing indicator,
// composer with attachments/voice/stickers/schedule, reply & edit state,
// read markers, infinite scroll-up, delivery receipts, link previews.
import { useEffect, useRef, useState, useCallback } from "react";
import { useStore } from "@/lib/client/store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { get, post, patch } from "@/lib/client/api";
import { reloadChatMessages, loadOlderMessages, emitTyping, queueMessage, emitDelivered } from "@/lib/client/socket";
import { uploadFile } from "@/lib/client/media";
import MessageBubble from "./message-bubble";
import { ChatAvatar } from "./chat-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Send, Paperclip, Smile, Mic, X, Phone, Video, MoreVertical, Info,
  Image as ImageIcon, Film, FileText, CalendarClock, ChevronDown, Trash2, ShieldAlert,
} from "lucide-react";
import { DEFAULT_STICKERS } from "@/lib/shared/constants";
import type { MessageDTO } from "@/lib/server/services/messages.service";

// stable empty references — Zustand v5 requires selectors to return cached values
const EMPTY_MESSAGES: MessageDTO[] = [];
const EMPTY_TYPING: Record<string, number> = {};

export default function ChatView() {
  const t = useT();
  const activeChatId = useStore((s) => s.activeChatId);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const messages = useStore((s) => (s.activeChatId ? s.messages[s.activeChatId] : undefined)) ?? EMPTY_MESSAGES;
  const hasMore = useStore((s) => (s.activeChatId ? !!s.hasMore[s.activeChatId] : false));
  const loading = useStore((s) => s.loadingMessages);
  const typingMap = useStore((s) => (s.activeChatId ? s.typing[s.activeChatId] : undefined)) ?? EMPTY_TYPING;
  const me = useStore((s) => s.me);
  const pinned = useStore((s) => (s.activeChatId ? s.pinnedBar[s.activeChatId] : null));
  const setView = useStore((s) => s.setView);

  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);
  const [draft, setDraft] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [recording, setRecording] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const onlineUsers = useStore((s) => s.onlineUsers);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef(0);

  // load messages on chat switch
  useEffect(() => {
    if (!activeChatId) return;
    stickToBottom.current = true;
    /* eslint-disable react-hooks/set-state-in-effect -- per-chat reset on id change */
    setReplyTo(null);
    setEditing(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    reloadChatMessages(activeChatId, true).catch(() => undefined);
    // load saved draft
    get<{ text: string }>(`chats/${activeChatId}/draft`).then((d) => setDraft(d.text)).catch(() => undefined);
  }, [activeChatId]);

  // mark read + delivery when messages arrive and chat is open
  useEffect(() => {
    if (!activeChatId || !chat || messages.length === 0) return;
    const topSeq = messages[messages.length - 1].seq;
    if (topSeq > (chat.lastReadSeq || 0) && topSeq < 9_000_000_000) {
      post(`chats/${activeChatId}/read`, { upToSeq: topSeq })
        .then(() => {
          emitDelivered(activeChatId, topSeq);
        })
        .catch(() => undefined);
    }
  }, [messages, activeChatId, chat]);

  // scroll behavior: stick to bottom unless user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, typingMap]);

  const onScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || !activeChatId) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && hasMore && !loading) {
      const prevHeight = el.scrollHeight;
      const loaded = await loadOlderMessages(activeChatId);
      if (loaded) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
        });
      }
    }
  }, [activeChatId, hasMore, loading]);

  if (!activeChatId || !chat) return null;

  const isSaved = chat.type === "saved";
  const typingNames = Object.keys(typingMap).filter((u) => u !== me?.id);

  const doSend = async () => {
    const text = draft.trim();
    if (!text && !editing) return;

    if (editing) {
      const newText = text;
      setEditing(null);
      setDraft("");
      await patch(`messages/${editing.id}`, { text: newText }).catch(() => undefined);
      reloadChatMessages(activeChatId, false).catch(() => undefined);
      return;
    }

    setDraft("");
    setReplyTo(null);
    setSendMenuOpen(false);
    queueMessage({
      chatId: activeChatId,
      text,
      replyToId: replyTo?.id,
      scheduledAt: scheduleAt || undefined,
    });
    if (scheduleAt) setScheduleAt("");
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const durationMs = Date.now() - recordStartRef.current;
        if (blob.size < 800) return;
        // compute waveform peaks (client-side, stored in metadata — spec §31)
        const peaks = await computePeaks(blob);
        const buf = await blob.arrayBuffer();
        try {
          const uploaded = await uploadFile(
            { buffer: buf, name: `voice-${Date.now()}.webm`, mime: "audio/webm", size: blob.size },
            "voice"
          ).promise;
          queueMessage({
            chatId: activeChatId,
            text: "",
            attachments: [{ mediaId: uploaded.mediaId, kind: "voice", meta: { durationMs, peaks } }],
          });
        } catch {
          /* upload failure surfaced via toast by caller flows */
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      recordStartRef.current = Date.now();
      setRecording(true);
    } catch {
      /* mic permission denied */
    }
  };

  const stopRecording = (send: boolean) => {
    const rec = recorderRef.current;
    setRecording(false);
    if (!rec) return;
    if (!send) rec.onstop = () => rec.stream.getTracks().forEach((tr) => tr.stop());
    rec.stop();
    recorderRef.current = null;
  };

  const sendFile = async (kind: string, accept: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      // client-side metadata for images/video (dimensions/duration) — spec §11
      const meta = await extractMeta(file, kind);
      try {
        const uploaded = await uploadFile(
          { buffer: buf, name: file.name, mime: file.type, size: file.size },
          kind
        ).promise;
        queueMessage({
          chatId: activeChatId,
          text: "",
          attachments: [{ mediaId: uploaded.mediaId, kind, filename: file.name, meta }],
        });
      } catch (e) {
        console.error("upload failed", e);
      }
    };
    input.click();
  };

  const canCall = chat.type === "private";

  return (
    <div className="h-full flex flex-col bg-background">
      {/* header */}
      <header className="h-14 flex items-center gap-3 px-3 border-b bg-teal-950 text-teal-50 shrink-0">
        <div className="md:hidden w-10" />
        <button className="flex items-center gap-3 flex-1 min-w-0 text-start" onClick={() => setView("group-info", chat.id)} aria-label={t.aboutChat}>
          <ChatAvatar chat={{ title: chat.title, type: chat.type }} size={38} />
          <div className="min-w-0">
            <p className="font-bold text-sm truncate">{chat.title}</p>
            <p className="text-xs text-teal-300 truncate">
              {typingNames.length > 0
                ? t.typing
                : chat.type === "private"
                  ? chat.peer && onlineUsers.has(chat.peer.id)
                    ? t.onlineNow
                    : chat.peer?.lastSeenAt
                      ? `${t.lastSeen} ${new Date(chat.peer.lastSeenAt).toLocaleDateString()}`
                      : ""
                  : chat.type === "saved"
                    ? t.savedChatDesc
                    : `${chat.memberCount} ${t.members}`}
            </p>
          </div>
        </button>
        {canCall && (
          <>
            <Button variant="ghost" size="icon" className="text-teal-100 hover:bg-teal-500/20" onClick={() => startCall(chat.peer?.id || "", chat.peer?.displayName || "", false)} aria-label={t.voiceCall}>
              <Phone className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" className="text-teal-100 hover:bg-teal-500/20" onClick={() => startCall(chat.peer?.id || "", chat.peer?.displayName || "", true)} aria-label={t.videoCall}>
              <Video className="w-4 h-4" />
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-teal-100 hover:bg-teal-500/20" aria-label="chat menu">
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setView("group-info", chat.id)}>
              <Info className="w-4 h-4 me-2" />{chat.type === "channel" ? t.channelInfo : t.groupInfo}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* pinned bar */}
      {pinned && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-amber-500/10 text-xs">
          <ChevronDown className="w-3 h-3 rotate-180 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="font-bold text-amber-600 dark:text-amber-400">{t.pinnedMessage}</p>
            <p className="truncate text-muted-foreground">{pinned.text}</p>
          </div>
        </div>
      )}

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3 bg-chat-pattern" onScroll={onScroll} role="log" aria-live="polite">
        {hasMore && (
          <div className="text-center pb-2">
            <Button variant="ghost" size="sm" className="text-xs" disabled={loading} onClick={() => loadOlderMessages(activeChatId)}>
              {loading ? t.loading : t.loadOlder}
            </Button>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            prev={i > 0 ? messages[i - 1] : undefined}
            chatType={chat.type}
            onReply={(m) => { setReplyTo(m); setEditing(null); }}
            onEdit={(m) => { setEditing(m); setDraft(m.text || ""); }}
            onOpenMedia={(mediaId) => { useStore.getState().setView("media-viewer", mediaId); }}
          />
        ))}
        {typingNames.length > 0 && (
          <div className="px-4 py-1">
            <div className="inline-flex items-center gap-1 bg-muted rounded-full px-3 py-1.5">
              <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}
      </div>

      {/* reply / edit banner */}
      {(replyTo || editing) && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t bg-muted/60 text-xs">
          {editing ? <PencilMark /> : <CornerMark />}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-teal-600 dark:text-teal-400">{editing ? t.editMessage : replyTo?.sender?.displayName}</p>
            <p className="truncate text-muted-foreground">{editing ? editing.text : replyTo?.text}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setReplyTo(null); setEditing(null); setDraft(""); }} aria-label={t.cancel}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* composer */}
      {chat.canPost || isSaved ? (
        <div className="border-t p-2 flex items-end gap-1.5 bg-background">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label={t.attach}>
                <Paperclip className="w-5 h-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-48 p-2">
              <AttachRow icon={<ImageIcon className="w-4 h-4" />} label={t.photo} onClick={() => sendFile("image", "image/*")} />
              <AttachRow icon={<Film className="w-4 h-4" />} label={t.video} onClick={() => sendFile("video", "video/*")} />
              <AttachRow icon={<FileText className="w-4 h-4" />} label={t.file} onClick={() => sendFile("document", "*/*")} />
              <AttachRow icon={<CalendarClock className="w-4 h-4" />} label={t.scheduleMessage} onClick={() => setScheduleOpen(true)} />
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label={t.sticker}>
                <Smile className="w-5 h-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-72 p-2">
              <div className="grid grid-cols-6 gap-1">
                {DEFAULT_STICKERS.map((emoji) => (
                  <button
                    key={emoji}
                    className="text-2xl hover:scale-125 transition-transform p-1"
                    onClick={() => {
                      // emoji stickers are sent as text — rendered large in bubbles
                      queueMessage({ chatId: activeChatId, text: emoji });
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value.slice(0, 4096));
              emitTyping(activeChatId, e.target.value.length > 0);
              if (e.target.value.length === 0) emitTyping(activeChatId, false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
            placeholder={isSaved ? t.savedChatDesc : t.typeMessage}
            className="min-h-[40px] max-h-32 resize-none py-2.5"
            rows={1}
            aria-label={t.typeMessage}
          />

          {draft.trim() ? (
            <Button className="shrink-0 bg-teal-600 hover:bg-teal-500 rounded-full w-10 h-10 p-0" onClick={doSend} aria-label={t.send}>
              <Send className="w-4 h-4 rtl:-scale-x-100" />
            </Button>
          ) : recording ? (
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={() => stopRecording(false)} aria-label={t.cancel}>
                <Trash2 className="w-5 h-5" />
              </Button>
              <Button className="shrink-0 bg-teal-600 hover:bg-teal-500 rounded-full w-10 h-10 p-0" onClick={() => stopRecording(true)} aria-label={t.send}>
                <Send className="w-4 h-4 rtl:-scale-x-100" />
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onClick={startRecording} aria-label={t.voiceMessage}>
              <Mic className="w-5 h-5" />
            </Button>
          )}
        </div>
      ) : (
        <div className="border-t p-3 text-center text-sm text-muted-foreground">
          <ShieldAlert className="w-4 h-4 inline me-1" />
          {chat.type === "channel" ? "Only admins can post" : "You cannot post here"}
        </div>
      )}

      {/* schedule dialog */}
      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t.scheduleMessage}</DialogTitle></DialogHeader>
          <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} aria-label={t.scheduleAt} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>{t.cancel}</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-500"
              disabled={!scheduleAt}
              onClick={() => {
                setScheduleOpen(false);
                setSendMenuOpen(false);
                // schedule applies to next send
                const at = new Date(scheduleAt).toISOString();
                queueMessage({ chatId: activeChatId, text: draft.trim(), scheduledAt: at });
                setDraft("");
              }}
            >
              {t.scheduleFor}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AttachRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-muted text-sm">
      {icon} {label}
    </button>
  );
}

function CornerMark() {
  return (
    <svg className="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v4" /></svg>
  );
}
function PencilMark() {
  return (
    <svg className="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
  );
}

/** WebAudio peaks for voice bubbles (client-side; metadata saved with msg). */
async function computePeaks(blob: Blob): Promise<number[]> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const channel = audio.getChannelData(0);
    const blocks = 28;
    const blockLen = Math.floor(channel.length / blocks) || 1;
    const peaks: number[] = [];
    for (let i = 0; i < blocks; i++) {
      let max = 0;
      for (let j = 0; j < blockLen; j++) {
        const v = Math.abs(channel[i * blockLen + j] || 0);
        if (v > max) max = v;
      }
      peaks.push(Math.min(1, max));
    }
    ctx.close().catch(() => undefined);
    return peaks;
  } catch {
    return [];
  }
}

async function extractMeta(file: File, kind: string): Promise<Record<string, unknown>> {
  if (kind === "image") {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({});
      img.src = URL.createObjectURL(file);
    });
  }
  if (kind === "video") {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ durationMs: Math.round(v.duration * 1000), w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => resolve({});
      v.src = URL.createObjectURL(file);
    });
  }
  return {};
}

// WebRTC call starter (handled in call-overlay.tsx)
function startCall(peerId: string, peerName: string, video: boolean) {
  const { setCall } = useStore.getState();
  setCall({ active: true, peerId, peerName, state: "connecting", video, callId: `call-${Date.now()}` });
  window.dispatchEvent(new CustomEvent("sada:call-start", { detail: { peerId, video } }));
}
