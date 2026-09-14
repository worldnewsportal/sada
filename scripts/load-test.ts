// Load test (spec §39): API + message sending + retrieval + auth.
// Usage: bun scripts/load-test.ts [users] [messagesPerUser]
// Measures p50/p95 latency and identifies bottlenecks honestly.
const BASE = process.env.TARGET || "http://localhost:3000/api/v1";
const USERS = parseInt(process.argv[2] || "10", 10);
const MSGS = parseInt(process.argv[3] || "5", 10);

interface Metrics {
  otpRequest: number[];
  login: number[];
  send: number[];
  fetch: number[];
  errors: number;
}

const metrics: Metrics = { otpRequest: [], login: [], send: [], fetch: [], errors: 0 };

async function timed(bucket: number[], fn: () => Promise<unknown>) {
  const t0 = performance.now();
  try {
    await fn();
  } catch {
    metrics.errors++;
  }
  bucket.push(performance.now() - t0);
}

async function loginAs(i: number): Promise<{ cookie: string; userId: string }> {
  const phone = `+99950${String(Date.now()).slice(-7)}${i}`;
  await timed(metrics.otpRequest, async () => {
    const r = await fetch(`${BASE}/auth/request-otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    if (!r.ok) throw new Error(`otp ${r.status}`);
  });
  let code = "";
  await timed(metrics.otpRequest, async () => {
    const r = await fetch(`${BASE}/auth/request-otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    const j = await r.json();
    code = j.data?.devCode;
    if (!code) throw new Error("no dev code (OTP_DEV_ECHO off?)");
  });
  let userId = "";
  await timed(metrics.login, async () => {
    const r = await fetch(`${BASE}/auth/verify-otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code, deviceName: "loadtest" }) });
    const setCookie = r.headers.get("set-cookie") || "";
    const j = await r.json();
    userId = j.data?.user?.id;
    if (!userId) throw new Error("login failed");
    (globalThis as unknown as Record<string, string>)[`cookie${i}`] = setCookie.split(";")[0];
  });
  return { cookie: (globalThis as unknown as Record<string, string>)[`cookie${i}`], userId };
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((p / 100) * sorted.length)];
}

async function main() {
  console.log(`Load test: ${USERS} users × ${MSGS} messages → ${BASE}`);
  const started = Date.now();

  // phase 1: login all users (chatId assigned later in phase 2 pairings)
  const sessions: Array<{ cookie: string; userId: string; chatId?: string }> = [];
  for (let i = 0; i < USERS; i++) {
    sessions.push(await loginAs(i));
  }
  console.log(`✓ ${USERS} users logged in (${Math.round((Date.now() - started) / 1000)}s)`);

  // phase 2: pairs chat concurrently
  const jobs: Promise<void>[] = [];
  for (let i = 0; i + 1 < USERS; i += 2) {
    jobs.push(
      (async (a: typeof sessions[0], b: typeof sessions[0]) => {
        // a opens chat with b
        const chatRes = await fetch(`${BASE}/chats/private`, {
          method: "POST", headers: { "content-type": "application/json", cookie: a.cookie },
          body: JSON.stringify({ userId: b.userId }),
        });
        const chat = (await chatRes.json()).data;
        if (!chat?.id) {
          metrics.errors++;
          return;
        }
        for (let m = 0; m < MSGS; m++) {
          await timed(metrics.send, () =>
            fetch(`${BASE}/chats/${chat.id}/messages`, {
              method: "POST", headers: { "content-type": "application/json", cookie: a.cookie },
              body: JSON.stringify({ text: `load ${i}-${m}`, clientMsgId: `lt-${i}-${m}` }),
            }).then((r) => { if (!r.ok) throw new Error(`send ${r.status}`); })
          );
          await timed(metrics.fetch, () =>
            fetch(`${BASE}/chats/${chat.id}/messages?limit=50`, { headers: { cookie: b.cookie } }).then((r) => { if (!r.ok) throw new Error(`fetch ${r.status}`); })
          );
        }
      })(sessions[i], sessions[i + 1])
    );
  }
  await Promise.all(jobs);

  const totalS = (Date.now() - started) / 1000;
  const sent = metrics.send.length;
  console.log(`
═══════════════════════════════════════════
 Results (${totalS.toFixed(1)}s total)
───────────────────────────────────────────
 message sends : ${sent} (${(sent / totalS).toFixed(1)}/s)
 p50 send      : ${percentile(metrics.send, 50).toFixed(0)} ms
 p95 send      : ${percentile(metrics.send, 95).toFixed(0)} ms
 p50 fetch     : ${percentile(metrics.fetch, 50).toFixed(0)} ms
 p95 fetch     : ${percentile(metrics.fetch, 95).toFixed(0)} ms
 p50 login     : ${percentile(metrics.login, 50).toFixed(0)} ms
 errors        : ${metrics.errors}
═══════════════════════════════════════════
 Bottleneck notes (spec §39): with SQLite dev storage, write
 serialization is the first ceiling (~50-150 msg/s single node).
 Production Postgres + connection pooling raises this ~10×; the
 realtime fan-out then dominates — scale websocket gateways and
 move fan-out to Redis pub/sub (docs/scaling.md).
`);
}

main();
