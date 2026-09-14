// ============================================================
// Storage abstraction (spec §8, §36): two real drivers.
//  - local: content-addressed on disk, served via signed API URLs
//  - s3: MinIO/S3 with SigV4 presigned PUT/GET (CDN in front in prod)
// Paths are content-addressed: /media/<h2>/<sha256>/<variant> —
// immutable → long CDN cache TTLs without invalidation (spec §36).
// ============================================================
import { createHash, createHmac } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { env } from "../env";

export function sha256Buf(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** media/<h2>/<hash>/<variant> — content-addressed (spec §36). */
export function contentKey(sha256: string, variant = "original"): string {
  return `media/${sha256.slice(0, 2)}/${sha256}/${variant}`;
}

export function uploadsKey(uploadId: string, part = 0): string {
  return part === 0 ? `uploads/${uploadId}/data` : `uploads/${uploadId}/part-${part}`;
}

function fsPath(key: string): string {
  // safe join: key is server-generated (no user input reaches here unvalidated)
  return `${key.startsWith("uploads/") ? env.UPLOAD_ROOT : env.MEDIA_ROOT}/${key}`;
}

export function ensureDirs() {
  for (const dir of [env.MEDIA_ROOT, env.UPLOAD_ROOT]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ---------------- local driver ----------------

export const local = {
  async write(key: string, data: Uint8Array): Promise<void> {
    const p = fsPath(key);
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await writeFile(p, data);
  },
  async appendPart(key: string, data: Uint8Array): Promise<void> {
    const { mkdir, appendFile } = await import("fs/promises");
    const p = fsPath(key);
    await mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await appendFile(p, data);
  },
  async read(key: string): Promise<Buffer | null> {
    const { readFile } = await import("fs/promises");
    try {
      return await readFile(fsPath(key));
    } catch {
      return null;
    }
  },
  async stat(key: string): Promise<{ size: number } | null> {
    const { stat } = await import("fs/promises");
    try {
      const s = await stat(fsPath(key));
      return { size: s.size };
    } catch {
      return null;
    }
  },
  async delete(key: string): Promise<void> {
    const { unlink } = await import("fs/promises");
    try {
      await unlink(fsPath(key));
    } catch {
      /* already gone */
    }
  },
  /** Concatenate uploaded parts into the final object. */
  async concatParts(uploadId: string, partCount: number, targetKey: string): Promise<void> {
    const { mkdir } = await import("fs/promises");
    const { createWriteStream } = await import("fs");
    const { pipeline } = await import("stream/promises");
    const { Readable } = await import("stream");
    const target = fsPath(targetKey);
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    const ws = createWriteStream(target);
    for (let i = 1; i <= partCount; i++) {
      const part = fsPath(uploadsKey(uploadId, i));
      const { existsSync } = await import("fs");
      if (!existsSync(part)) throw new Error(`Missing part ${i}`);
      const chunk = await this.read(uploadsKey(uploadId, i));
      if (!chunk) throw new Error(`Missing part ${i}`);
      ws.write(chunk);
    }
    ws.end();
    await new Promise((resolve, reject) => (ws.on("finish", resolve), ws.on("error", reject)));
  },
};

// ---------------- S3 driver (SigV4 presign — no SDK needed) ----------------

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export const s3 = {
  presignUrl(key: string, method: "PUT" | "GET", expiresS = 900): string {
    const endpoint = env.S3_ENDPOINT.replace(/\/$/, "");
    const region = env.S3_REGION;
    const bucket = env.S3_BUCKET;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const canonicalUri = `/${bucket}/${key}`;
    const query = [
      `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
      `X-Amz-Credential=${encodeURIComponent(`${env.S3_ACCESS_KEY}/${credentialScope}`)}`,
      `X-Amz-Date=${amzDate}`,
      `X-Amz-Expires=${expiresS}`,
      `X-Amz-SignedHeaders=host`,
    ].join("&");
    const canonicalRequest = [
      method,
      canonicalUri,
      query,
      `host:${new URL(endpoint).host}`,
      ``,
      `host`,
      `UNSIGNED-PAYLOAD`,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const kDate = hmac(`AWS4${env.S3_SECRET_KEY}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    return `${endpoint}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
  },

  async put(key: string, data: Uint8Array): Promise<void> {
    const url = this.presignUrl(key, "PUT", 600);
    const res = await fetch(url, { method: "PUT", body: data as unknown as BodyInit });
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
  },
};

/** Driver-agnostic write used by worker/API. */
export async function storageWrite(key: string, data: Uint8Array): Promise<void> {
  if (env.STORAGE_DRIVER === "s3") return s3.put(key, data);
  return local.write(key, data);
}

/** Public URL for a media object (CDN base in production). */
export function publicMediaUrl(key: string): string {
  if (env.CDN_BASE_URL) return `${env.CDN_BASE_URL}/${key}`;
  return `/media/${key}`; // local dev: reverse proxy can serve directly
}
