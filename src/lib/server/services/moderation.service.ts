// ============================================================
// Moderation service (spec §22): reports, categories, admin actions.
// Reports never auto-delete content — a human/moderation rule decides.
// ============================================================
import { db } from "@/lib/db";
import { ApiError } from "../errors";
import { ulid } from "@/lib/ulid";
import { Limits, REPORT_CATEGORIES } from "@/lib/shared/constants";
import { enforceRateLimit } from "../security/rate-limit";
import { appendAudit } from "./audit.service";

export async function createReport(userId: string, input: {
  targetType: "user" | "message" | "chat";
  targetId: string;
  category: string;
  description?: string;
}) {
  enforceRateLimit("reports:create", userId);
  if (!REPORT_CATEGORIES.includes(input.category as (typeof REPORT_CATEGORIES)[number])) {
    throw ApiError.badRequest(`category must be one of: ${REPORT_CATEGORIES.join(", ")}`);
  }
  if (input.description && input.description.length > Limits.MAX_MESSAGE_LEN) {
    throw ApiError.badRequest("Description too long");
  }
  // target existence check
  let exists = false;
  if (input.targetType === "user") exists = !!(await db.user.findUnique({ where: { id: input.targetId } }));
  if (input.targetType === "message") exists = !!(await db.message.findUnique({ where: { id: input.targetId } }));
  if (input.targetType === "chat") exists = !!(await db.chat.findUnique({ where: { id: input.targetId } }));
  if (!exists) throw ApiError.notFound("Report target not found");

  const report = await db.report.create({
    data: {
      id: ulid(),
      reporterId: userId,
      targetType: input.targetType,
      targetId: input.targetId,
      category: input.category,
      description: input.description || null,
    },
  });
  return { reportId: report.id, status: report.status };
}
