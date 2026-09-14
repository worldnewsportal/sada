// Consistent error envelope + typed API errors (spec §5: consistent error responses).
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(msg = "Bad request", details?: unknown) {
    return new ApiError(400, "BAD_REQUEST", msg, details);
  }
  static unauthorized(msg = "Authentication required") {
    return new ApiError(401, "UNAUTHORIZED", msg);
  }
  static forbidden(msg = "Permission denied") {
    return new ApiError(403, "FORBIDDEN", msg);
  }
  static notFound(msg = "Not found") {
    return new ApiError(404, "NOT_FOUND", msg);
  }
  static conflict(code: string, msg: string, details?: unknown) {
    return new ApiError(409, code, msg, details);
  }
  static tooLarge(msg = "Payload too large") {
    return new ApiError(413, "TOO_LARGE", msg);
  }
  static rateLimited(retryAfterS: number) {
    return new ApiError(429, "RATE_LIMITED", "Too many requests", { retryAfterS });
  }
  static internal(msg = "Internal server error") {
    return new ApiError(500, "INTERNAL", msg);
  }
  static unavailable(msg = "Service unavailable") {
    return new ApiError(503, "UNAVAILABLE", msg);
  }
}

export function errorResponse(err: unknown, requestId: string) {
  if (err instanceof ApiError) {
    return Response.json(
      { ok: false, error: { code: err.code, message: err.message, details: err.details }, requestId },
      { status: err.status, headers: { "x-request-id": requestId } }
    );
  }
  // Unexpected — log fully, return sanitized
  return Response.json(
    { ok: false, error: { code: "INTERNAL", message: "Internal server error" }, requestId },
    { status: 500, headers: { "x-request-id": requestId } }
  );
}
