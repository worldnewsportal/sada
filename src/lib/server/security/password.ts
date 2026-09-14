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

// Top common passwords (denylist — never store these even if they pass length).
const COMMON_PASSWORDS = new Set([
  "password", "password1", "12345678", "123456789", "1234567890", "qwerty123",
  "11111111", "00000000", "abc12345", "iloveyou", "administrator", "welcome1",
  "monkey123", "dragon123", "letmein123", "password123", "qwertyuiop", "1q2w3e4r5t",
]);

/** Password policy for user accounts: solid but not hostile (min 8, letter+digit, not common). */
export function validateUserPassword(pw: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password must be at most 128 characters";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "Password must contain letters and numbers";
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return "This password is too common — choose another";
  return null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
