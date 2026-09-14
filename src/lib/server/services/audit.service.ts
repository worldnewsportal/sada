// Audit logging (spec §16, §37) — security-relevant actions are recorded.
import { db } from "@/lib/db";

export async function appendAudit(entry: {
  actorType: "user" | "admin" | "system";
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detailJson?: string | null;
  ip?: string | null;
}) {
  try {
    await db.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detailJson: entry.detailJson ?? null,
        ip: entry.ip ?? null,
      },
    });
  } catch {
    // audit must never break the main flow; a failed write is surfaced via logs
    console.error("audit-write-failed", entry.action);
  }
}
