// Generates docs/openapi.json from the live route table (spec §43).
// Run: bun scripts/gen-openapi.ts
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";

// Import the route module — registers every route into the global router.
await import("../src/app/api/v1/[...route]/route");
const router = (globalThis as unknown as { __sadaRouter?: { routes: Array<{ method: string; pattern: string; auth: boolean }> } }).__sadaRouter;
if (!router) throw new Error("router not registered");

const METHOD_MAP: Record<string, string> = { GET: "get", POST: "post", PATCH: "patch", PUT: "put", DELETE: "delete" };

const paths: Record<string, Record<string, unknown>> = {};
for (const route of router.routes) {
  const path = "/api/v1/" + route.pattern.replace(/:([a-zA-Z]+)/g, "{$1}");
  paths[path] ??= {};
  paths[path][METHOD_MAP[route.method] || "get"] = {
    summary: `${route.method} ${route.pattern}`,
    tags: [route.pattern.split("/")[0]],
    security: route.auth ? [{ sessionCookie: [] }] : [],
    parameters: (route.pattern.match(/:([a-zA-Z]+)/g) || []).map((p) => ({
      name: p.slice(1),
      in: "path",
      required: true,
      schema: { type: "string" },
    })),
    responses: {
      200: { description: "ok — {ok:true,data}" },
      400: { description: "validation error" },
      401: { description: "unauthenticated" },
      403: { description: "forbidden / permission denied" },
      404: { description: "not found" },
      429: { description: "rate limited (retryAfterS in details)" },
    },
  };
}

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Sada Messenger API",
    version: "1.0.0",
    description: "Versioned REST API (spec §5). Realtime event protocol documented in docs/api.md.",
  },
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "sada_session" },
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  paths,
};

mkdirSync("docs", { recursive: true });
writeFileSync(join("docs", "openapi.json"), JSON.stringify(spec, null, 2));
console.log(`openapi.json written: ${Object.keys(paths).length} paths, ${router.routes.length} operations`);
