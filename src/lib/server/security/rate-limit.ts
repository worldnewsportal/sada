// Sliding-window rate limiter (spec §23).
// Interface matches a Redis-backed store so production can swap the driver
// (see docs/scaling.md) without touching call sites.
import { RateLimits } from "@/lib/shared/constants";
import { ApiError } from "../errors";

interface Bucket {
  hits: number[]; // timestamps within window
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): { count: number; resetMs: number };
}

class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number) {
    const now = Date.now();
    // periodic sweep to bound memory (spec: logs/state must not grow unbounded)
    if (now - this.lastSweep > 60_000) {
      for (const [k, b] of this.buckets) {
        b.hits = b.hits.filter((t) => now - t < windowMs * 2);
        if (b.hits.length === 0) this.buckets.delete(k);
      }
      this.lastSweep = now;
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
    bucket.hits.push(now);
    const oldest = bucket.hits[0];
    return { count: bucket.hits.length, resetMs: oldest + windowMs - now };
  }
}

// Single shared store per process (API, realtime and worker each keep one;
// production deployment uses Redis via RATE_LIMIT_URL — docs/scaling.md).
const globalStore = globalThis as unknown as { __rateStore?: RateLimitStore };
export const rateStore: RateLimitStore = globalStore.__rateStore ?? new MemoryStore();
globalStore.__rateStore = rateStore;

/** Enforce a named limit; throws ApiError 429 with Retry-After. */
export function enforceRateLimit(name: string, ...keyParts: (string | number)[]) {
  const cfg = RateLimits[name] || RateLimits["api:default"];
  const key = `${name}:${keyParts.join(":")}`;
  const { count, resetMs } = rateStore.hit(key, cfg.windowMs);
  if (count > cfg.max) {
    const retryAfterS = Math.max(1, Math.ceil(resetMs / 1000));
    throw ApiError.rateLimited(retryAfterS);
  }
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "127.0.0.1";
}
