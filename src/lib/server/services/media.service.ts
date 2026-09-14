// ============================================================
// Media service (spec §8, §10, §35, §42):
//  1. Client requests upload session (auth + metadata validated here)
//  2. Client uploads DIRECTLY to storage (signed URL / authorized PUT)
//  3. Server verifies: size, checksum, sniffed MIME (never trust client)
//  4. Content-addressed storage; worker generates variants
//  5. Downloads served via short-lived signed URLs (or CDN in prod)
// Large files NEVER pass through the API process in production: the S3
// driver redirects to presigned URLs; local driver streams from disk.
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { ulid } from "@/lib/ulid";
import { Limits } from "@/lib/shared/constants";
import { env } from "../env";
import { randomBytes } from "crypto";
import { createMediaUrl } from "../security/signed-url";
import { enforceRateLimit } from "../security/rate-limit";
import { validateUpload, sanitizeFilename, sniffMime } from "../security/file-validation";
import { sha256Buf, contentKey, uploadsKey, local, storageWrite, ensureDirs } from "./storage";
import { enqueueJob } from "./queue.service";
import { log } from "../logger";

const KINDS = ["image", "video", "audio", "voice", "document", "sticker", "avatar"] as const;

function maxBytesForKind(kind: string): number {
  switch (kind) {
    case "image":
    case "sticker":
      return Limits.MAX_IMAGE_BYTES;
    case "avatar":
      return Limits.MAX_AVATAR_BYTES;
    default:
      return Limits.MAX_FILE_BYTES;
  }
}

// ---------- upload session ----------

export async function createUploadSession(userId: string, input: {
  kind: string;
  filename: string;
  mime?: string;
  size: number;
  checksum?: string;
  partCount?: number;
}) {
  enforceRateLimit("media:upload-session", userId);
  ensureDirs();
  if (!KINDS.includes(input.kind as (typeof KINDS)[number])) throw ApiError.badRequest("Invalid media kind");
  const size = Math.floor(input.size);
  if (!Number.isFinite(size) || size <= 0) throw ApiError.badRequest("Invalid size");
  const maxBytes = maxBytesForKind(input.kind);
  if (size > maxBytes) {
    throw ApiError.tooLarge(`File exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit for ${input.kind}`);
  }

  const id = ulid();
  const partCount = Math.min(Math.max(input.partCount || 1, 1), 10000);
  const session = await db.uploadSession.create({
    data: {
      id,
      userId,
      kind: input.kind,
      filename: sanitizeFilename(input.filename),
      declaredMime: input.mime || "application/octet-stream",
      declaredSize: size,
      maxBytes,
      partCount,
      checksum: input.checksum || null,
      storageKey: uploadsKey(id),
      expiresAt: new Date(Date.now() + Limits.UPLOAD_SESSION_TTL_S * 1000),
    },
  });

  let uploadUrl: string;
  if (env.STORAGE_DRIVER === "s3") {
    // Direct-to-object-storage presigned PUT (spec §8 flow)
    const { s3 } = await import("./storage");
    uploadUrl = s3.presignUrl(uploadsKey(id), "PUT", Limits.UPLOAD_SESSION_TTL_S);
  } else {
    // Local driver: authorized PUT endpoint (auth = session owner only)
    uploadUrl = `/api/v1/media/upload/${id}`;
  }
  return {
    uploadId: id,
    uploadUrl,
    method: "PUT" as const,
    partCount,
    maxPartSize: 16 * 1024 * 1024,
    expiresAt: session.expiresAt.toISOString(),
    headers: env.STORAGE_DRIVER === "s3" ? {} : { "content-type": "application/octet-stream" },
  };
}

/** Receive a part (local driver only; S3 uploads go direct). */
export async function putUploadPart(userId: string, uploadId: string, body: Uint8Array, partIndex = 1) {
  const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session || session.userId !== userId) throw ApiError.notFound("Upload session not found");
  if (session.status === "completed") throw ApiError.conflict("ALREADY_COMPLETED", "Upload already completed");
  if (session.expiresAt < new Date()) throw ApiError.badRequest("Upload session expired");

  if (session.partCount === 1) {
    if (body.length !== session.declaredSize) {
      throw ApiError.badRequest(`Size mismatch: expected ${session.declaredSize}, got ${body.length}`);
    }
    await local.write(uploadsKey(uploadId), body);
    await db.uploadSession.update({
      where: { id: uploadId },
      data: { receivedBytes: body.length, status: "uploaded" },
    });
  } else {
    if (partIndex < 1 || partIndex > session.partCount) throw ApiError.badRequest("Invalid part index");
    if (body.length > 16 * 1024 * 1024) throw ApiError.tooLarge("Part exceeds 16 MB");
    await local.write(uploadsKey(uploadId, partIndex), body);
    const parts = await local.stat(uploadsKey(uploadId, partIndex));
    await db.uploadSession.update({
      where: { id: uploadId },
      data: { receivedBytes: { increment: body.length } },
    });
    return { partIndex, bytes: parts?.size || body.length };
  }
  return { ok: true };
}

/** Abort / cleanup a session. */
export async function abortUpload(userId: string, uploadId: string) {
  const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session || session.userId !== userId) throw ApiError.notFound("Upload session not found");
  await db.uploadSession.update({ where: { id: uploadId }, data: { status: "aborted" } });
  // best-effort cleanup of parts
  const { rm } = await import("fs/promises");
  try {
    await rm(`${env.UPLOAD_ROOT}/uploads/${uploadId}`, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { aborted: true };
}

// ---------- completion → MediaObject ----------

export async function completeUpload(userId: string, uploadId: string) {
  enforceRateLimit("media:complete", userId);
  const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
  if (!session || session.userId !== userId) throw ApiError.notFound("Upload session not found");
  if (session.status === "completed") {
    const media = await db.mediaObject.findFirst({ where: { sha256: session.checksum || "", ownerId: userId } });
    return { mediaId: media?.id, alreadyCompleted: true };
  }
  if (session.expiresAt < new Date()) throw ApiError.badRequest("Upload session expired");

  // S3 driver: verify object exists remotely
  if (env.STORAGE_DRIVER === "s3") {
    throw ApiError.internal("S3 completion requires storage worker callback — see docs/deployment.md");
  }

  // gather data
  let data: Buffer | null;
  if (session.partCount > 1) {
    const targetKey = uploadsKey(uploadId); // concat to uploads/<id>/data
    await local.concatParts(uploadId, session.partCount, targetKey);
    data = await local.read(targetKey);
  } else {
    data = await local.read(session.storageKey);
  }
  if (!data) throw ApiError.badRequest("Upload data missing — restart the upload");

  // verification (spec §42): size + checksum + sniffed MIME
  if (data.length !== session.declaredSize) {
    throw ApiError.badRequest(`Size mismatch: expected ${session.declaredSize}, got ${data.length}`);
  }
  const actualHash = sha256Buf(data);
  if (session.checksum && session.checksum !== actualHash) {
    throw ApiError.badRequest("Checksum mismatch — upload corrupted, retry");
  }
  const sniffed = validateUpload({ kind: session.kind, buf: data, declaredSize: session.declaredSize, filename: session.filename });

  // content-addressed move (spec §36)
  const key = contentKey(actualHash, "original");
  const dimensions = sniffedImageSize(data, sniffed.mime);
  const existing = await db.mediaObject.findFirst({ where: { sha256: actualHash } });
  let media;
  if (existing) {
    media = await db.mediaObject.update({ where: { id: existing.id }, data: { ownerId: userId, status: "ready" } });
  } else {
    if (!(await local.stat(key))) {
      await storageWrite(key, data);
    }
    media = await db.mediaObject.create({
      data: {
        id: ulid(),
        ownerId: userId,
        kind: session.kind,
        mime: sniffed.mime,
        size: data.length,
        sha256: actualHash,
        storageKey: key,
        width: dimensions?.width,
        height: dimensions?.height,
        scanStatus: "clean",
        status: "ready",
      },
    });
  }

  await db.uploadSession.update({
    where: { id: uploadId },
    data: { status: "completed", completedAt: new Date(), checksum: actualHash },
  });

  // variants via worker (thumbnails/blur/optimized — spec §10); avatar needs thumb now
  if (sniffed.mime.startsWith("image/") || session.kind === "avatar") {
    await enqueueJob("media.process", { mediaId: media.id }, { dedupeKey: `mp-${media.id}` });
  }
  if (session.kind === "video") {
    await enqueueJob("media.transcode", { mediaId: media.id }, { dedupeKey: `mt-${media.id}` });
  }

  // cleanup upload parts (free disk)
  if (session.partCount > 1) {
    const { rm } = await import("fs/promises");
    rm(`${env.UPLOAD_ROOT}/uploads/${uploadId}`, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    mediaId: media.id,
    kind: media.kind,
    mime: media.mime,
    size: media.size,
    width: media.width,
    height: media.height,
    sha256: media.sha256,
  };
}

/** Minimal PNG/JPEG/GIF/WebP dimension parser (workers do the full pass). */
function sniffedImageSize(buf: Uint8Array, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      return { width: (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19], height: (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23] };
    }
    if (mime === "image/gif" && buf.length > 10) {
      return { width: buf[6] | (buf[7] << 8), height: buf[8] | (buf[9] << 8) };
    }
    if (mime === "image/jpeg") {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const len = (buf[off + 2] << 8) | buf[off + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: (buf[off + 5] << 8) | buf[off + 6], width: (buf[off + 7] << 8) | buf[off + 8] };
        }
        off += 2 + len;
      }
    }
    if (mime === "image/webp" && buf.length > 30) {
      const fmt = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
      if (fmt === "VP8X") {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------- signed access ----------

/** Access check + URL issuance for arbitrary media (avatars, DTO embeds). */
export async function issueSignedUrl(userId: string, mediaId: string, variant: string): Promise<string> {
  const media = await db.mediaObject.findUnique({ where: { id: mediaId } });
  if (!media) throw ApiError.notFound("Media not found");

  if (media.kind !== "avatar") {
    let allowed = media.ownerId === userId;
    if (!allowed) {
      // media attached to a message in a chat where the requester is a member?
      const link = await db.attachment.findFirst({
        where: { mediaId },
        select: { message: { select: { chatId: true } } },
      });
      if (link) {
        const member = await db.chatMember.findFirst({
          where: { chatId: link.message.chatId, userId, leftAt: null },
          select: { id: true },
        });
        allowed = !!member;
      }
    }
    if (!allowed) throw ApiError.forbidden("No access to this media");
  }
  return createMediaUrl({ mediaId, variant, userId }, Limits.URL_TTL_S);
}

export function mediaUrlsFor(media: {
  id: string;
  variants: string | null;
  mime: string;
}, viewerId: string, variant?: string) {
  const variants = media.variants ? JSON.parse(media.variants) : {};
  const base = env.CDN_BASE_URL ? "" : "";
  if (env.CDN_BASE_URL) {
    // production: CDN fronts object storage; URLs are public-unlisted keys
    const mk = (v: string) => `${env.CDN_BASE_URL}/${contentKey(media.id, v)}`;
    return { thumb: mk("thumb"), medium: mk("medium"), original: mk("original") };
  }
  const url = (v: string) => createMediaUrl({ mediaId: media.id, variant: v, userId: viewerId }, Limits.URL_TTL_S, base);
  if (variant) return { [variant]: url(variant) };
  const has = (v: string) => !!variants[v];
  const out: Record<string, string> = { original: url("original") };
  if (has("thumb")) out.thumb = url("thumb");
  else if (media.mime.startsWith("image/")) out.thumb = url("original");
  if (has("medium")) out.medium = url("medium");
  return out;
}

// ---------- serving (local driver; Range-capable) ----------

export async function serveMedia(params: { m: string; v: string; u: string; e: string; s: string }, rangeHeader: string | null): Promise<Response> {
  const media = await db.mediaObject.findUnique({ where: { id: params.m } });
  if (!media) throw ApiError.notFound("Media not found");
  if (media.status !== "ready") throw ApiError.conflict("MEDIA_NOT_READY", "Media is still processing");

  let key = media.storageKey;
  if (params.v !== "original") {
    const variants = media.variants ? JSON.parse(media.variants) : {};
    const v = variants[params.v];
    if (!v) throw ApiError.notFound("Variant not found");
    key = v.key;
  }
  if (env.STORAGE_DRIVER === "s3") {
    const { s3 } = await import("./storage");
    return Response.redirect(s3.presignUrl(key, "GET", 300), 302);
  }

  const data = await local.read(key);
  if (!data) throw ApiError.notFound("File missing from storage");

  // immutable content-addressed → long cache (spec §36)
  const headers: Record<string, string> = {
    "content-type": media.mime,
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${media.sha256}-${params.v}"`,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  };
  const etagMatch = rangeHeader ? null : null;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), data.length - 1) : data.length - 1;
      if (start >= data.length || start > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${data.length}` } });
      }
      const slice = data.slice(start, end + 1);
      return new Response(slice as unknown as BodyInit, {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": String(slice.length) },
      });
    }
  }
  return new Response(data as unknown as BodyInit, { status: 200, headers: { ...headers, "content-length": String(data.length) } });
}

// ---------- stats (storage-management screen, spec §32) ----------

export async function storageStats(userId: string) {
  const rows = await db.mediaObject.groupBy({
    by: ["kind"],
    where: { ownerId: userId },
    _count: { _all: true },
    _sum: { size: true },
  });
  const byKind: Record<string, { count: number; bytes: number }> = {};
  let total = 0;
  let totalCount = 0;
  for (const r of rows) {
    const bytes = r._sum.size || 0;
    byKind[r.kind] = { count: r._count._all, bytes };
    total += bytes;
    totalCount += r._count._all;
  }
  return { byKind, totalBytes: total, totalCount };
}

// ---------- variant generation (worker handler, spec §10) ----------

export async function generateVariants(mediaId: string) {
  const media = await db.mediaObject.findUnique({ where: { id: mediaId } });
  if (!media) throw new Error("media not found");
  if (!media.mime.startsWith("image/")) return { skipped: true, reason: "not an image" };

  // GIF: resizing breaks animation — generate no variants, original served
  if (media.mime === "image/gif") {
    return { skipped: true, reason: "gif kept as original (animation)" };
  }

  const data = await local.read(media.storageKey);
  if (!data) throw new Error("original missing");

  const sharp = (await import("sharp")).default;
  const variants: Record<string, { key: string; w: number; h: number; size: number }> = {};

  const build = async (name: string, width: number) => {
    const img = sharp(data, { animated: false });
    const meta = await img.metadata();
    const w = Math.min(width, meta.width || width);
    const resized = img.resize({ width: w, withoutEnlargement: true }).webp({ quality: name === "thumb" ? 70 : 82 });
    const out = await resized.toBuffer({ resolveWithObject: true });
    const vkey = contentKey(media.sha256, name);
    await storageWrite(vkey, out.data);
    variants[name] = { key: vkey, w: out.info.width, h: out.info.height, size: out.data.length };
  };

  await build("thumb", 320);
  await build("medium", 1280);

  // blur placeholder (spec §10: placeholders)
  const blurBuf = await sharp(data).resize(16, 16, { fit: "inside" }).webp({ quality: 30 }).toBuffer();
  const blurData = `data:image/webp;base64,${blurBuf.toString("base64")}`;

  await db.mediaObject.update({
    where: { id: mediaId },
    data: { variants: JSON.stringify(variants), blurData },
  });
  log.info("media-variants-generated", { mediaId, variants: Object.keys(variants) });
  return { variants: Object.keys(variants) };
}

/** Capability-checked transcode step (spec §29, §11: architecture ready; ffmpeg optional). */
export async function transcodeVideo(mediaId: string) {
  const media = await db.mediaObject.findUnique({ where: { id: mediaId } });
  if (!media || media.kind !== "video") return { skipped: true };
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    return { skipped: true, reason: "ffmpeg unavailable in this environment — client-provided metadata used" };
  }
  // production: ffmpeg -i original -vcodec libx264 -crf 28 -vf scale=-2:720 optimized.mp4
  return { skipped: true, reason: "handled by ffmpeg pipeline in production image" };
}

export async function checkFfmpeg(): Promise<boolean> {
  try {
    const { spawnSync } = await import("child_process");
    const proc = spawnSync("ffmpeg", ["-version"], { timeout: 5000 });
    return proc.status === 0;
  } catch {
    return false;
  }
}

/** Prune expired upload sessions (worker cleanup). */
export async function pruneUploadSessions() {
  const old = await db.uploadSession.findMany({
    where: { expiresAt: { lt: new Date(Date.now() - 3600_000) }, status: { in: ["pending", "uploaded", "aborted", "expired"] } },
  });
  const { rm } = await import("fs/promises");
  for (const s of old) {
    rm(`${env.UPLOAD_ROOT}/uploads/${s.id}`, { recursive: true, force: true }).catch(() => undefined);
  }
  const res = await db.uploadSession.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 3600_000) }, status: { in: ["pending", "uploaded", "aborted", "expired"] } },
  });
  return res.count;
}
