// Password hashing for admin accounts (bcrypt cost 12 — spec §37).
import bcrypt from "bcryptjs";
import { createHash } from "crypto";

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

/** Password policy for admin accounts (separate & stronger — spec §37). */
export function validateAdminPassword(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "Must contain lower and upper case letters";
  if (!/\d/.test(pw)) return "Must contain a digit";
  if (!/[^a-zA-Z0-9]/.test(pw)) return "Must contain a symbol";
  return null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
