// HMAC-signed, expiring URLs for media access (spec §8-9).
// Works for both drivers: local (path token) and S3 (delegated presign).
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";

export interface MediaUrlScope {
  mediaId: string;
  variant?: string; // original|thumb|medium|optimized
  userId: string; // bound to the requester — URLs are not shareable across users
}

function sign(payload: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
}

/** Build a short-lived signed media URL (default TTL 15 min). */
export function createMediaUrl(scope: MediaUrlScope, ttlS: number = 900, baseUrl = ""): string {
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  const variant = scope.variant || "original";
  const body = `${scope.mediaId}.${variant}.${scope.userId}.${exp}`;
  const sig = sign(body);
  const qs = `m=${scope.mediaId}&v=${variant}&u=${scope.userId}&e=${exp}&s=${sig}`;
  return `${baseUrl}/api/v1/media/file?${qs}`;
}

/** Verify a signed media URL. Throws on any mismatch. */
export function verifyMediaUrl(params: {
  m: string;
  v: string;
  u: string;
  e: string;
  s: string;
}): MediaUrlScope {
  const exp = parseInt(params.e, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    throw new Error("expired");
  }
  const body = `${params.m}.${params.v}.${params.u}.${params.e}`;
  const expected = sign(body);
  const a = Buffer.from(expected);
  const b = Buffer.from(params.s || "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("bad-signature");
  }
  return { mediaId: params.m, variant: params.v, userId: params.u };
}

/** HMAC for internal service-to-service calls (API → realtime emit). */
export function internalSignature(body: string, ts: number): string {
  return createHmac("sha256", env.INTERNAL_SECRET).update(`${ts}.${body}`).digest("base64url");
}

export function verifyInternalSignature(body: string, ts: number, sig: string): boolean {
  if (Math.abs(Date.now() / 1000 - ts) > 60) return false; // replay window 60s
  const a = Buffer.from(internalSignature(body, ts));
  const b = Buffer.from(sig || "");
  return a.length === b.length && timingSafeEqual(a, b);
}
