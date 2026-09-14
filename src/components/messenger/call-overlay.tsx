"use client";
// WebRTC 1:1 calls (voice/video + screen share) — signaling relayed via
// the realtime service (call:offer/answer/ice/end). Calls-ready spec §113.
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/client/store";
import { useT } from "@/lib/i18n";
import { getSocket } from "@/lib/client/socket";
import { Button } from "@/components/ui/button";
import { Phone, PhoneOff, MonitorUp, Mic, MicOff } from "lucide-react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

function getLocalStream(video: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 640 } : false });
}

export default function CallOverlay() {
  const t = useT();
  const call = useStore((s) => s.call);
  const setCall = useStore((s) => s.setCall);
  const [micOn, setMicOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  function teardown() {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    localStreamRef.current = null;
  }

  function endCall() {
    const current = useStore.getState().call;
    if (current?.peerId) getSocket()?.emit("call:end", { toUserId: current.peerId, callId: current.callId });
    teardown();
    setCall(null);
  }

  function buildPc(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        getSocket()?.emit("call:ice", { toUserId: peerId, candidate: e.candidate.toJSON(), callId: useStore.getState().call?.callId });
      }
    };
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        useStore.setState((s) => ({ call: s.call ? { ...s.call, state: "connected" } : null }));
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        endCall();
      }
    };
    pcRef.current = pc;
    return pc;
  }

  async function startOutgoing(peerId: string, video: boolean) {
    try {
      setStatus(t.calling);
      const stream = await getLocalStream(video);
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const pc = buildPc(peerId);
      stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      getSocket()?.emit("call:offer", {
        toUserId: peerId,
        sdp: offer,
        video,
        callId: useStore.getState().call?.callId,
        peerName: useStore.getState().me?.displayName,
      });
    } catch {
      setStatus("camera/mic unavailable");
      setTimeout(() => setCall(null), 1500);
    }
  }

  async function acceptCall() {
    const callState = useStore.getState().call;
    if (!callState?.peerId) return;
    try {
      setStatus(t.inCall);
      const stream = await getLocalStream(!!callState.video);
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const pc = buildPc(callState.peerId);
      stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
      if (callState.pendingOffer) {
        await pc.setRemoteDescription(new RTCSessionDescription(callState.pendingOffer));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      getSocket()?.emit("call:answer", { toUserId: callState.peerId, sdp: answer, callId: callState.callId });
      useStore.setState((s) => ({ call: s.call ? { ...s.call, state: "connecting" } : null }));
    } catch {
      endCall();
    }
  }

  async function toggleScreenShare() {
    const pc = pcRef.current;
    if (!pc) return;
    if (sharing) {
      const camStream = await getLocalStream(!!useStore.getState().call?.video).catch(() => null);
      if (!camStream) return;
      const track = camStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender && track) await sender.replaceTrack(track);
      localStreamRef.current = camStream;
      if (localVideoRef.current) localVideoRef.current.srcObject = camStream;
      setSharing(false);
    } else {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = display.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        if (localVideoRef.current) localVideoRef.current.srcObject = display;
        track.onended = () => setSharing(false);
        setSharing(true);
      } catch {
        /* share cancelled */
      }
    }
  }

  // ---- incoming call listener ----
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onEvent = async (ev: { type: string; payload?: Record<string, unknown> }) => {
      const pc = pcRef.current;
      const { payload } = ev;
      if (ev.type === "CALL_OFFER") {
        if (!payload || useStore.getState().call) return;
        setCall({
          active: true,
          peerId: payload.fromUserId as string,
          peerName: (payload.peerName as string) || "Caller",
          callId: payload.callId as string,
          incoming: true,
          video: !!payload.video,
          state: "ringing",
          pendingOffer: payload.sdp as RTCSessionDescriptionInit,
        });
      } else if (ev.type === "CALL_ANSWER" && pc && payload?.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp as RTCSessionDescriptionInit));
        useStore.setState((s) => ({ call: s.call ? { ...s.call, state: "connected" } : null }));
      } else if (ev.type === "CALL_ICE" && pc && payload?.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate as RTCIceCandidateInit)).catch(() => undefined);
      } else if (ev.type === "CALL_END") {
        teardown();
        setCall(null);
      }
    };
    socket.on("event", onEvent);
    return () => {
      socket.off("event", onEvent);
    };
     
  }, [setCall]);

  // ---- outgoing call starter ----
  useEffect(() => {
    const start = (e: Event) => {
      const detail = (e as CustomEvent).detail as { peerId: string; video: boolean };
      startOutgoing(detail.peerId, detail.video);
    };
    window.addEventListener("sada:call-start", start);
    return () => window.removeEventListener("sada:call-start", start);
     
  }, []);

  useEffect(() => () => teardown(), []);  

  if (!call) return null;

  const incomingRinging = call.incoming && call.state === "ringing";

  return (
    <div className="fixed inset-0 z-[70] bg-teal-950/95 flex flex-col items-center justify-center gap-6 text-teal-50" role="dialog" aria-modal>
      <audio ref={remoteAudioRef} autoPlay />

      <div className="text-center space-y-1">
        <p className="text-xl font-bold">{call.peerName}</p>
        <p className="text-sm text-teal-300">
          {call.state === "ringing" ? (call.incoming ? t.incomingCall : t.calling) : call.state === "connected" ? t.inCall : status || t.connecting}
        </p>
      </div>

      {call.video && (
        <div className="relative w-full max-w-md aspect-video bg-black/50 rounded-2xl overflow-hidden">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          <video ref={localVideoRef} autoPlay playsInline muted className="absolute bottom-2 end-2 w-24 aspect-video object-cover rounded-lg border border-teal-500/40" />
        </div>
      )}
      {!call.video && <video ref={localVideoRef} autoPlay playsInline muted className="hidden" />}

      <div className="flex items-center gap-4">
        {incomingRinging ? (
          <>
            <Button size="lg" className="rounded-full w-16 h-16 p-0 bg-red-500 hover:bg-red-400" onClick={endCall} aria-label={t.reject}>
              <PhoneOff className="w-6 h-6" />
            </Button>
            <Button size="lg" className="rounded-full w-16 h-16 p-0 bg-emerald-500 hover:bg-emerald-400" onClick={acceptCall} aria-label={t.accept}>
              <Phone className="w-6 h-6" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="rounded-full w-12 h-12 p-0 text-teal-100 hover:bg-white/10" onClick={() => {
              const track = localStreamRef.current?.getAudioTracks()[0];
              if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
            }} aria-label="mic">
              {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-red-400" />}
            </Button>
            {call.video && (
              <Button variant="ghost" className="rounded-full w-12 h-12 p-0 text-teal-100 hover:bg-white/10" onClick={toggleScreenShare} aria-label={t.shareScreen}>
                <MonitorUp className={sharing ? "w-5 h-5 text-amber-400" : "w-5 h-5"} />
              </Button>
            )}
            <Button size="lg" className="rounded-full w-16 h-16 p-0 bg-red-500 hover:bg-red-400" onClick={endCall} aria-label={t.endCall}>
              <PhoneOff className="w-6 h-6" />
            </Button>
          </>
        )}
      </div>
      <p className="text-[10px] text-teal-400/60">P2P WebRTC · STUN</p>
    </div>
  );
}
