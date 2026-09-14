// ============================================================
// API core: tiny router with request IDs, auth context, validation,
// consistent envelope and rate limiting (spec §5).
// All /api/v1 routes delegate to this; logic lives in service modules.
// ============================================================
import { ApiError, errorResponse } from "./errors";
import { log } from "./logger";
import { verifyToken, TokenPayload } from "./jwt";
import { enforceRateLimit, clientIp } from "./security/rate-limit";
import { db } from "@/lib/db";
import { randomUUID } from "crypto";

export interface AuthContext {
  userId: string;
  sessionId: string;
  user: {
    id: string;
    phone: string;
    username: string | null;
    displayName: string;
    isVerified: boolean;
    bannedUntil: Date | null;
    twofaEnabled: boolean;
  };
}

export interface Ctx {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  ip: string;
  /** Present only on authenticated routes. */
  auth?: AuthContext;
  /** JSON body (parsed once, validated by zod in services). */
  json: <T>() => Promise<T>;
  /** Raw body bytes (uploads). */
  bytes: () => Promise<Uint8Array>;
  cookies: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;

export interface RouteDef {
  method: string;
  /** e.g. "chats/:id/messages" */
  pattern: string;
  auth: boolean;
  handler: Handler;
}

export class Router {
  routes: RouteDef[] = [];

  add(method: string, pattern: string, auth: boolean, handler: Handler) {
    this.routes.push({ method: method.toUpperCase(), pattern, auth, handler });
    return this;
  }

  get(pattern: string, handler: Handler, opts?: { auth?: boolean }) {
    return this.add("GET", pattern, opts?.auth !== false, handler);
  }
  post(pattern: string, handler: Handler, opts?: { auth?: boolean }) {
    return this.add("POST", pattern, opts?.auth !== false, handler);
  }
  patch(pattern: string, handler: Handler, opts?: { auth?: boolean }) {
    return this.add("PATCH", pattern, opts?.auth !== false, handler);
  }
  put(pattern: string, handler: Handler, opts?: { auth?: boolean }) {
    return this.add("PUT", pattern, opts?.auth !== false, handler);
  }
  delete(pattern: string, handler: Handler, opts?: { auth?: boolean }) {
    return this.add("DELETE", pattern, opts?.auth !== false, handler);
  }

  match(method: string, segments: string[]): { route: RouteDef; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const pat = route.pattern.split("/").filter(Boolean);
      if (pat.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i].startsWith(":")) {
          params[pat[i].slice(1)] = decodeURIComponent(segments[i]);
        } else if (pat[i] !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setAuthCookie(response: Response, name: string, value: string, maxAgeS: number) {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  response.headers.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAgeS}`
  );
}

export function clearAuthCookie(name: string): string {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=0`;
}

/** Resolve the authenticated user from Authorization header or session cookie. */
export async function resolveAuth(req: Request, cookies: Record<string, string>): Promise<AuthContext | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer || cookies["sada_session"];
  if (!token) return null;
  const payload: TokenPayload | null = await verifyToken(token, "access");
  if (!payload) return null;

  const session = await db.session.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.deletedAt) return null;
  if (session.user.bannedUntil && session.user.bannedUntil > new Date()) {
    // Banned users keep read-only local cache; API access denied.
    throw ApiError.forbidden("Account suspended");
  }

  // touch last-active at most once per minute (write load control)
  if (Date.now() - session.lastActiveAt.getTime() > 60_000) {
    db.session
      .update({ where: { id: session.id }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    userId: session.userId,
    sessionId: session.id,
    user: {
      id: session.user.id,
      phone: session.user.phone,
      username: session.user.username,
      displayName: session.user.displayName,
      isVerified: session.user.isVerified,
      bannedUntil: session.user.bannedUntil,
      twofaEnabled: session.user.twofaEnabled,
    },
  };
}

/** Wrap a router into the Next.js App Router catch-all handler. */
export function createApiHandler(router: Router) {
  return async (req: Request, routeCtx: { params: Promise<{ route?: string[] }> }): Promise<Response> => {
    const requestId = randomUUID();
    const started = Date.now();
    const { route } = await routeCtx.params;
    const segments = (route || []).filter(Boolean);
    const url = new URL(req.url);

    try {
      const matched = router.match(req.method, segments);
      if (!matched) {
        throw ApiError.notFound(`No route for ${req.method} /api/v1/${segments.join("/")}`);
      }
      const { route: def, params } = matched;

      let bodyBuffer: Uint8Array | null = null;
      const ctx: Ctx = {
        req,
        params,
        query: url.searchParams,
        requestId,
        ip: clientIp(req),
        json: async <T,>() => {
          if (!bodyBuffer) {
            bodyBuffer = new Uint8Array(await req.arrayBuffer());
          }
          try {
            return JSON.parse(new TextDecoder().decode(bodyBuffer)) as T;
          } catch {
            throw ApiError.badRequest("Invalid JSON body");
          }
        },
        bytes: async () => {
          if (!bodyBuffer) bodyBuffer = new Uint8Array(await req.arrayBuffer());
          return bodyBuffer;
        },
        cookies: parseCookies(req.headers.get("cookie")),
      };

      if (def.auth) {
        const resolved = await resolveAuth(req, ctx.cookies);
        if (!resolved) throw ApiError.unauthorized();
        ctx.auth = resolved;
      }

      // default per-API rate limit (services add stricter named limits)
      enforceRateLimit("api:default", ctx.auth?.userId ?? ctx.ip);

      const res = await def.handler(ctx);
      res.headers.set("x-request-id", requestId);
      const durMs = Date.now() - started;
      if (durMs > 1000 || url.pathname.startsWith("/api/v1/admin")) {
        log.info("api", { method: req.method, path: url.pathname, status: res.status, durMs, requestId });
      }
      return res;
    } catch (err) {
      if (!(err instanceof ApiError)) {
        log.error("api-unhandled", {
          requestId,
          method: req.method,
          path: url.pathname,
          err: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
        });
      }
      return errorResponse(err, requestId);
    }
  };
}

/** Standard success envelope. */
export function ok(data: unknown, init?: ResponseInit): Response {
  return Response.json({ ok: true, data }, init);
}

export function paginated<T>(items: T[], opts: { nextCursor?: number | null; hasMore: boolean }): Response {
  return Response.json({ ok: true, data: { items, ...opts } });
}
