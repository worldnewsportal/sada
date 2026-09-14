// ============================================================
// Shared constants — wire protocol, permissions, limits.
// Used by API, realtime service, worker and the client.
// ============================================================

/** Realtime event protocol (spec §6). */
export const Events = {
  MESSAGE_CREATED: "MESSAGE_CREATED",
  MESSAGE_UPDATED: "MESSAGE_UPDATED",
  MESSAGE_DELETED: "MESSAGE_DELETED",
  MESSAGE_READ: "MESSAGE_READ",
  MESSAGE_DELIVERED: "MESSAGE_DELIVERED",
  MESSAGE_REACTION_UPDATED: "MESSAGE_REACTION_UPDATED",
  MESSAGE_PINNED: "MESSAGE_PINNED",
  USER_TYPING: "USER_TYPING",
  USER_ONLINE: "USER_ONLINE",
  USER_OFFLINE: "USER_OFFLINE",
  CHAT_UPDATED: "CHAT_UPDATED",
  CHAT_PINNED: "CHAT_PINNED",
  MEMBER_ADDED: "MEMBER_ADDED",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  ADMIN_CHANGED: "ADMIN_CHANGED",
  CHANNEL_POSTED: "CHANNEL_POSTED",
  NOTIFICATION_CREATED: "NOTIFICATION_CREATED",
  // operational
  SYNC_CURSOR: "SYNC_CURSOR",
  CALL_OFFER: "CALL_OFFER",
  CALL_ANSWER: "CALL_ANSWER",
  CALL_ICE: "CALL_ICE",
  CALL_END: "CALL_END",
} as const;
export type EventName = (typeof Events)[keyof typeof Events];

/** Granular chat permissions (spec §20). */
export interface PermissionSet {
  canDeleteMessages: boolean;
  canBanMembers: boolean;
  canInviteMembers: boolean;
  canPinMessages: boolean;
  canChangeInfo: boolean;
  canManageTopics: boolean;
  canPostMessages: boolean; // channels
  canEditMessages: boolean; // channel admins editing posts
  canAddAdmins: boolean;
  canRestrictMembers: boolean;
}

export const OWNER_PERMISSIONS: PermissionSet = {
  canDeleteMessages: true,
  canBanMembers: true,
  canInviteMembers: true,
  canPinMessages: true,
  canChangeInfo: true,
  canManageTopics: true,
  canPostMessages: true,
  canEditMessages: true,
  canAddAdmins: true,
  canRestrictMembers: true,
};

export const ADMIN_PERMISSIONS: PermissionSet = {
  canDeleteMessages: true,
  canBanMembers: true,
  canInviteMembers: true,
  canPinMessages: true,
  canChangeInfo: false,
  canManageTopics: true,
  canPostMessages: true,
  canEditMessages: true,
  canAddAdmins: false,
  canRestrictMembers: true,
};

export const MODERATOR_PERMISSIONS: PermissionSet = {
  canDeleteMessages: true,
  canBanMembers: false,
  canInviteMembers: true,
  canPinMessages: true,
  canChangeInfo: false,
  canManageTopics: false,
  canPostMessages: true,
  canEditMessages: false,
  canAddAdmins: false,
  canRestrictMembers: true,
};

export const MEMBER_PERMISSIONS: PermissionSet = {
  canDeleteMessages: false, // own messages only (handled in service)
  canBanMembers: false,
  canInviteMembers: true,
  canPinMessages: false,
  canChangeInfo: false,
  canManageTopics: false,
  canPostMessages: true, // groups only; channels restrict via role
  canEditMessages: false,
  canAddAdmins: false,
  canRestrictMembers: false,
};

export const ROLE_DEFAULTS: Record<string, PermissionSet> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  moderator: MODERATOR_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  subscriber: { ...MEMBER_PERMISSIONS, canPostMessages: false, canInviteMembers: false },
  restricted: { ...MEMBER_PERMISSIONS, canPostMessages: false, canInviteMembers: false },
};

export type ChatType = "private" | "group" | "channel" | "saved";

/** Platform limits (spec §23, §42). */
export const Limits = {
  MAX_MESSAGE_LEN: 4096,
  MAX_FILE_BYTES: 512 * 1024 * 1024, // 512 MB
  MAX_IMAGE_BYTES: 25 * 1024 * 1024,
  MAX_AVATAR_BYTES: 8 * 1024 * 1024,
  MAX_IMAGE_DIMENSION: 8000,
  MAX_VIDEO_DURATION_S: 3600,
  MAX_VOICE_DURATION_S: 600,
  MAX_CAPTION_LEN: 1024,
  MAX_CHAT_NAME: 128,
  MAX_BIO: 280,
  MAX_ABOUT: 255,
  MAX_MESSAGE_PAGE: 100,
  MAX_ATTACHMENTS: 10,
  MAX_GROUP_BASIC: 200,
  USERNAME_MIN: 4,
  USERNAME_MAX: 32,
  URL_TTL_S: 900, // signed URL expiry (spec §9: short expiration)
  UPLOAD_SESSION_TTL_S: 3600,
} as const;

/** Rate limit table (spec §23) — per key, window ms, max hits. Env-overridable. */
export const RateLimits: Record<string, { windowMs: number; max: number }> = {
  "auth:request-otp": { windowMs: 60_000, max: 3 },
  "auth:verify-otp": { windowMs: 60_000, max: 8 },
  "auth:login-ip": { windowMs: 60_000, max: 20 },
  "auth:refresh": { windowMs: 60_000, max: 60 },
  // email auth (signup/login by code, password login)
  "auth:request-email-otp": { windowMs: 60_000, max: 3 },
  "auth:verify-email-otp": { windowMs: 60_000, max: 8 },
  "auth:login-password": { windowMs: 60_000, max: 8 },
  "messages:send": { windowMs: 10_000, max: 25 },
  "messages:edit": { windowMs: 10_000, max: 30 },
  "media:upload-session": { windowMs: 60_000, max: 60 },
  "media:complete": { windowMs: 60_000, max: 60 },
  "users:set-username": { windowMs: 24 * 3600_000, max: 5 },
  "chats:create-group": { windowMs: 3600_000, max: 20 },
  "chats:create-channel": { windowMs: 3600_000, max: 10 },
  "search:global": { windowMs: 60_000, max: 60 },
  "api:default": { windowMs: 60_000, max: 300 },
  "reactions:set": { windowMs: 10_000, max: 30 },
  "reports:create": { windowMs: 3600_000, max: 20 },
  "admin:login": { windowMs: 60_000, max: 10 },
  "calls:signal": { windowMs: 10_000, max: 60 },
};

/** Report categories (spec §22). */
export const REPORT_CATEGORIES = [
  "spam",
  "harassment",
  "illegal_content",
  "copyright",
  "violence",
  "scam",
  "other",
] as const;

export const PRIVACY_VISIBILITY = ["everyone", "contacts", "nobody"] as const;

/** Media kinds and allowed sniffed MIME types. */
export const ALLOWED_MIME_PREFIXES: Record<string, string[]> = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"],
  audio: ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/opus"],
  voice: ["audio/webm", "audio/ogg", "audio/mp4", "audio/aac", "audio/opus"],
  document: ["application/pdf", "application/zip", "application/x-7z-compressed", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "text/plain", "text/csv",
    "application/epub+zip", "application/rtf", "application/octet-stream"],
  sticker: ["image/webp", "image/png"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
};

export const DEFAULT_STICKERS = [
  "😀","😂","🥹","😍","🤩","😎","🤔","😴","🥳","😭","😡","🤯",
  "👍","👎","👏","🙏","💪","🤝","❤️","🔥","🎉","⭐","💯","🚀",
];
