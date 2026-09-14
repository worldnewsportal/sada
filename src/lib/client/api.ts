"use client";
// ============================================================
// Client API layer: envelope handling, auto token refresh (spec §15),
// offline-tolerant. All calls go through here.
// ============================================================

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  requestId?: string;
}

let refreshPromise: Promise<boolean> | null = null;

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  const body = init?.body;
  const isBinary = body instanceof ArrayBuffer || body instanceof Uint8Array;
  return fetch(`/api/v1/${path}`, {
    ...init,
    headers: {
      ...(body && !isBinary ? { "content-type": "application/json" } : {}),
      ...(isBinary ? { "content-type": "application/octet-stream" } : {}),
      ...init?.headers,
    },
    credentials: "include",
  });
}

/** Refresh the access token via the rotating refresh cookie. */
export async function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await rawFetch("auth/refresh", { method: "POST", body: JSON.stringify({}) });
        const json = (await res.json()) as ApiEnvelope<unknown>;
        return !!json.ok;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshPromise = null), 100);
      }
    })();
  }
  return refreshPromise;
}

export async function api<T>(path: string, init?: RequestInit & { retryOn401?: boolean }): Promise<T> {
  const res = await rawFetch(path, init);
  if (res.status === 401 && init?.retryOn401 !== false && !path.startsWith("auth/")) {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, { ...init, retryOn401: false });
    throw new ApiClientError("UNAUTHORIZED", "Session expired", 401);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    if (!res.ok) throw new ApiClientError("HTTP_ERROR", `HTTP ${res.status}`, res.status);
    return undefined as unknown as T;
  }
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!json.ok) {
    const details = json.error?.details as { retryAfterS?: number } | undefined;
    throw new ApiClientError(json.error?.code || "ERROR", json.error?.message || "Unknown error", res.status, details);
  }
  return json.data as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });
export const put = <T,>(path: string, body: ArrayBuffer | Uint8Array, part?: number) =>
  api<T>(path + (part ? `?part=${part}` : ""), { method: "PUT", body: body as unknown as BodyInit });
