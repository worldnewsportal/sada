// JWT (access tokens) via jose — HS256, short-lived (spec §15).
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

export interface TokenPayload {
  sub: string; // user id
  sid: string; // session id
  typ: "access" | "socket" | "admin" | "twofa";
}

export async function signAccessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret());
}

/** Short-lived token for websocket auth (60s — enough to connect). */
export async function signSocketToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId, typ: "socket" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(secret());
}

/** Short-lived ticket proving the first auth factor passed (2FA step). */
export async function signTwofaTicket(userId: string): Promise<string> {
  return new SignJWT({ sid: "twofa", typ: "twofa" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(secret());
}

export async function signAdminToken(adminId: string): Promise<string> {
  return new SignJWT({ typ: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(adminId)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

export async function verifyToken(token: string, expected: TokenPayload["typ"]): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.typ !== expected) return null;
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}
