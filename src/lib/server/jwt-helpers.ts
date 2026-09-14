import { verifyToken } from "./jwt";

/** Extract the user id from a 2FA ticket, or null. */
export async function verifyTwofaTicket(ticket: string): Promise<string | null> {
  const payload = await verifyToken(ticket, "twofa");
  return payload ? payload.sub : null;
}
