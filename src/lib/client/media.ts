"use client";
// ============================================================
// Media upload client (spec §8 flow, §35 progress/cancel):
// 1. upload-session  2. direct PUT (parts for big files)
// 3. complete → MediaObject  4. attach to message
// Progress callbacks + abort support.
// ============================================================
import { post, put, get } from "./api";

export interface UploadSessionResp {
  uploadId: string;
  uploadUrl: string;
  method: "PUT";
  partCount: number;
  maxPartSize: number;
  expiresAt: string;
  headers: Record<string, string>;
}

export interface UploadHandle {
  promise: Promise<UploadComplete>;
  abort: () => void;
}

export interface UploadComplete {
  mediaId: string;
  kind: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  sha256: string;
}

const PART_SIZE = 8 * 1024 * 1024; // 8 MB parts → resumable retries

export function uploadFile(
  file: { buffer: ArrayBuffer; name: string; mime: string; size: number },
  kind: string,
  onProgress?: (pct: number, speedBps: number) => void,
  extra?: { checksum?: string; meta?: Record<string, unknown> }
): UploadHandle {
  const controller = new AbortController();
  const startedAt = Date.now();

  const promise = (async (): Promise<UploadComplete> => {
    const session = await post<UploadSessionResp>("media/upload-session", {
      kind,
      filename: file.name,
      mime: file.mime,
      size: file.size,
      checksum: extra?.checksum,
      partCount: Math.max(1, Math.ceil(file.size / PART_SIZE)),
    });

    const data = new Uint8Array(file.buffer);
    if (session.uploadUrl.startsWith("/api/")) {
      // local driver: parts via authorized endpoint
      if (session.partCount === 1) {
        await put("media/upload/" + session.uploadId, data);
      } else {
        for (let i = 0; i < session.partCount; i++) {
          if (controller.signal.aborted) throw new Error("aborted");
          const part = data.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
          await put("media/upload/" + session.uploadId, part, i + 1);
          const sent = (i + 1) * PART_SIZE;
          reportProgress(sent, file.size, startedAt, onProgress);
        }
      }
    } else {
      // S3 presigned direct PUT (browser → storage, API bypassed)
      const res = await fetch(session.uploadUrl, {
        method: "PUT",
        body: file.buffer,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      reportProgress(file.size, file.size, startedAt, onProgress);
    }

    const result = await post<UploadComplete>(`media/upload/${session.uploadId}/complete`);
    return result;
  })();

  return { promise, abort: () => controller.abort() };
}

function reportProgress(sent: number, total: number, startedAt: number, cb?: (pct: number, speed: number) => void) {
  if (!cb) return;
  const elapsedS = Math.max(0.001, (Date.now() - startedAt) / 1000);
  cb(Math.min(100, Math.round((sent / total) * 100)), sent / elapsedS);
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mediaStats() {
  return get<{ byKind: Record<string, { count: number; bytes: number }>; totalBytes: number; totalCount: number }>("media/stats");
}
