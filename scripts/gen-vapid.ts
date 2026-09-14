// Generates VAPID keys for Web Push (spec §18). Run: bun scripts/gen-vapid.ts
import webpush from "web-push";
import { appendFileSync, existsSync, readFileSync } from "fs";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);

// convenience: append to .env if not already present
if (existsSync(".env")) {
  const env = readFileSync(".env", "utf8");
  if (!env.includes("VAPID_PUBLIC_KEY=") || env.includes("VAPID_PUBLIC_KEY=\n")) {
    appendFileSync(".env", `\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
    console.log("→ appended to .env");
  }
}
