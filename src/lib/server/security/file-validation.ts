// Server-side content validation (spec §42: never trust filename/MIME/extension).
// Magic-byte sniffing for the exact set of allowed media types.
import { Limits, ALLOWED_MIME_PREFIXES } from "@/lib/shared/constants";
import { ApiError } from "../errors";

interface SniffResult {
  mime: string;
  ext: string;
}

/** Detect real content type from magic bytes. Returns octet-stream when unknown. */
export function sniffMime(buf: Uint8Array): SniffResult {
  const b = buf;
  const startsWith = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);

  if (startsWith(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { mime: "image/png", ext: "png" };
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", ext: "gif" };
  // RIFF....WEBP
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  // ftyp box: MP4/MOV variants
  if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith("qt")) return { mime: "video/quicktime", ext: "mov" };
    return { mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) {
    // Matroska/WebM — distinguish via DocType later; webm dominant for web recordings
    return { mime: "video/webm", ext: "webm" };
  }
  if (startsWith(0x49, 0x44, 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (startsWith(0x4f, 0x67, 0x67, 0x53)) return { mime: "audio/ogg", ext: "ogg" };
  if (startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
    return { mime: "audio/wav", ext: "wav" };
  }
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return { mime: "application/pdf", ext: "pdf" };
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) {
    // ZIP family: docx/xlsx/pptx/epub/zip — refine by extension, default zip
    return { mime: "application/zip", ext: "zip" };
  }
  if (startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { mime: "application/x-7z-compressed", ext: "7z" };
  if (startsWith(0x1f, 0x8b)) return { mime: "application/gzip", ext: "gz" };

  // text/plain heuristic: valid UTF-8 with no control chars in first 512 bytes
  const sample = b.slice(0, 512);
  let isText = sample.length > 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 0x09 && byte !== 0x00)) {
      isText = false;
      break;
    }
  }
  if (isText) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return { mime: "text/plain", ext: "txt" };
    } catch {
      /* binary */
    }
  }
  return { mime: "application/octet-stream", ext: "bin" };
}

const EXT_OVERRIDES: Record<string, SniffResult> = {
  doc: { mime: "application/msword", ext: "doc" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  xls: { mime: "application/vnd.ms-excel", ext: "xls" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  ppt: { mime: "application/vnd.ms-powerpoint", ext: "ppt" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  csv: { mime: "text/csv", ext: "csv" },
  epub: { mime: "application/epub+zip", ext: "epub" },
};

/**
 * Validate an upload against the declared kind.
 *Throws ApiError on violation; returns the verified MIME + safe filename.
 */
export function validateUpload(opts: {
  kind: string;
  buf: Uint8Array;
  declaredSize: number;
  filename?: string | null;
}): SniffResult {
  const { kind, buf, declaredSize } = opts;

  if (declaredSize > Limits.MAX_FILE_BYTES) {
    throw ApiError.tooLarge(`File exceeds maximum size of ${Math.floor(Limits.MAX_FILE_BYTES / 1024 / 1024)} MB`);
  }
  if (buf.length !== declaredSize) {
    throw ApiError.badRequest("Size mismatch between declared and actual bytes");
  }
  if (kind === "image" && declaredSize > Limits.MAX_IMAGE_BYTES) {
    throw ApiError.tooLarge("Image exceeds 25 MB limit");
  }

  const sniffed = sniffMime(buf);
  const allowed = ALLOWED_MIME_PREFIXES[kind];
  if (!allowed) throw ApiError.badRequest("Unknown media kind");

  // ZIP-family documents: trust safe extension to refine (docx/xlsx/pptx are zip)
  let finalMime = sniffed.mime;
  const ext = (opts.filename || "").split(".").pop()?.toLowerCase() || "";
  if (sniffed.mime === "application/zip" && EXT_OVERRIDES[ext]) {
    finalMime = EXT_OVERRIDES[ext].mime;
  }
  if (kind === "document" && sniffed.mime === "application/octet-stream" && EXT_OVERRIDES[ext]) {
    finalMime = EXT_OVERRIDES[ext].mime;
  }

  const ok =
    allowed.some((m) => finalMime === m) ||
    (kind === "document" && (finalMime.startsWith("text/") || finalMime.startsWith("application/")));
  if (!ok) {
    throw ApiError.badRequest(`Content sniffed as "${sniffed.mime}" is not allowed for kind "${kind}"`);
  }
  return { mime: finalMime, ext: sniffed.ext };
}

/** Sanitize a client-supplied filename (spec §42: prevent path traversal/malicious names). */
export function sanitizeFilename(name: string | null | undefined, fallback = "file"): string {
  if (!name) return fallback;
  const base = name.split(/[\\/]/).pop() || fallback; // strip any path components
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim();
  const limited = cleaned.slice(0, 180);
  return limited.length > 0 ? limited : fallback;
}
