// Link preview fetcher (spec §38) — SSRF-guarded, size-capped, OG parser.
import { db } from "@/lib/db";
import { createHash } from "crypto";
import { appendAndEmit } from "@/lib/server/events";
import { Events } from "@/lib/shared/constants";

const MAX_HTML_BYTES = 1024 * 1024; // 1 MB
const TIMEOUT_MS = 6000;

/** Block private/loopback targets (SSRF protection, spec §16). */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // metadata endpoints
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast/reserved
  }
  if (h === "[::1]" || h.startsWith("fc") || h.startsWith("fd") || h === "::1") return true;
  return false;
}

function metaTag(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m = html.match(re) || html.match(alt);
  if (!m) return null;
  return decodeHtml(m[1]).slice(0, 500);
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeHtml(m[1]).slice(0, 200) : null;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

export async function fetchLinkPreview(
  messageId: string,
  rawUrl: string
): Promise<Record<string, unknown> | { skipped: true; reason: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { skipped: true, reason: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { skipped: true, reason: "bad protocol" };
  if (isBlockedHost(url.hostname)) return { skipped: true, reason: "blocked host (SSRF guard)" };

  const urlHash = createHash("sha256").update(url.toString()).digest("hex");
  const existing = await db.linkPreview.findUnique({ where: { urlHash } });
  if (!existing) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "SadaBot/1.0 (+link-preview)", accept: "text/html" },
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`job-skip: HTTP ${res.status}`);
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) throw new Error(`job-skip: non-html (${ct.split(";")[0]})`);
      const reader = res.body?.getReader();
      let html = "";
      if (reader) {
        let received = 0;
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          html += decoder.decode(value, { stream: true });
          if (received > MAX_HTML_BYTES) {
            reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const preview = {
        title: metaTag(html, "og:title") || titleTag(html) || url.hostname,
        description: metaTag(html, "og:description") || metaTag(html, "description"),
        siteName: metaTag(html, "og:site_name") || url.hostname,
        imageUrl: metaTag(html, "og:image"),
        url: url.toString().slice(0, 2000),
      };
      await db.linkPreview.create({
        data: {
          id: crypto.randomUUID(),
          urlHash,
          url: preview.url,
          title: preview.title,
          description: preview.description,
          siteName: preview.siteName,
          imageUrl: preview.imageUrl,
        },
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("job-skip:")) throw e;
      return { skipped: true, reason: `fetch failed: ${String(e).slice(0, 120)}` };
    }
  }
  const preview = await db.linkPreview.findUnique({ where: { urlHash } });
  if (!preview) return { skipped: true, reason: "preview unavailable" };

  const message = await db.message.findUnique({ where: { id: messageId } });
  if (message) {
    // attach preview id into message meta (read by clients)
    const meta = message.meta ? JSON.parse(message.meta) : {};
    meta.linkPreviewId = preview.id;
    await db.message.update({ where: { id: messageId }, data: { meta: JSON.stringify(meta) } });
    await appendAndEmit([
      {
        type: Events.MESSAGE_UPDATED,
        chatId: message.chatId,
        actorId: message.senderId,
        payload: { messageId, linkPreview: preview },
      },
    ]);
  }
  return { stored: true };
}
