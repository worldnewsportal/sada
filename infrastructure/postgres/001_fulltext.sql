// -- Sada production Postgres migration (baseline schema, spec §12, §40) --
// Applied automatically by `prisma migrate deploy` (schema.postgres.prisma).
// This file adds the Postgres-specific pieces Prisma cannot express:
// full-text search (spec §19) and identity sequences.
//
-- Full-text search: messages
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "unaccent";

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', COALESCE("text", ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS message_search_idx
  ON "Message" USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS message_text_trgm_idx
  ON "Message" USING GIN ("text" gin_trgm_ops);

-- Public chat discovery trigram search
CREATE INDEX IF NOT EXISTS chat_title_trgm_idx
  ON "Chat" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS user_name_trgm_idx
  ON "User" USING GIN ("displayName" gin_trgm_ops);

-- Event log retention helper
CREATE INDEX IF NOT EXISTS event_created_at_idx
  ON "Event" ("createdAt");

-- Search query helper (used by search service in production mode)
CREATE OR REPLACE FUNCTION search_messages(p_chat_ids text[], p_query text, p_limit int DEFAULT 50)
RETURNS TABLE("id" text, "chatId" text, "seq" int, "text" text, "createdAt" timestamptz) AS $$
  SELECT m."id", m."chatId", m."seq", m."text", m."createdAt"
  FROM "Message" m
  WHERE m."chatId" = ANY(p_chat_ids)
    AND m."status" = 'sent'
    AND m.search_vector @@ plainto_tsquery('simple', p_query)
  ORDER BY m."seq" DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE;
