// ============================================================
// Email self-test — proves REAL delivery end-to-end.
//
//   bun scripts/test-email.ts you@example.com             # send via configured provider
//   bun scripts/test-email.ts --ethereal                  # self-provisioned REAL SMTP test
//   bun scripts/test-email.ts --status                    # show resolved provider only
//
// --ethereal auto-creates a REAL SMTP account (ethereal.email — nodemailer's
// official test mailserver), then sends through THIS app's SmtpEmailProvider.
// It validates the exact production code path: resolver → nodemailer →
// TLS → AUTH → message accepted. Output includes a web URL to view the mail.
// ============================================================
import { getEmailProvider, hasRealEmailProvider, renderEmailOtp, resolveEmailProviderName } from "../src/lib/server/security/email";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "";
  const status = resolveEmailProviderName();

  if (mode === "--status") {
    console.log(`${CYAN}provider:${RESET} ${status.provider}${status.real ? "" : ` (${status.hint})`}`);
    console.log(`${CYAN}real delivery:${RESET} ${status.real ? "YES" : "NO"}`);
    if (!status.real)
      console.log(`${YELLOW}hint:${RESET} set RESEND_API_KEY or BREVO_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS — see .env.example`);
    return;
  }

  if (mode === "--ethereal") {
    console.log(`${BOLD}[1/3] Creating a REAL SMTP account at ethereal.email…${RESET}`);
    const nodemailer = await import("nodemailer");
    const acct = await nodemailer.createTestAccount();
    // Wire the freshly-created REAL credentials into the app's env layer
    process.env.SMTP_HOST = acct.smtp.host;
    process.env.SMTP_PORT = String(acct.smtp.port);
    process.env.SMTP_SECURE = String(acct.smtp.secure);
    process.env.SMTP_USER = acct.user;
    process.env.SMTP_PASS = acct.pass;
    process.env.EMAIL_FROM = `Sada Test <${acct.user}>`;
    console.log(`${GREEN}  ✓ real SMTP server:${RESET} ${acct.smtp.host}:${acct.smtp.port} (secure=${acct.smtp.secure})`);

    console.log(`${BOLD}[2/3] Sending through THIS app's SmtpEmailProvider…${RESET}`);
    const provider = getEmailProvider();
    if (provider.name !== "smtp") throw new Error(`expected smtp provider, got ${provider.name}`);
    const mail = renderEmailOtp({ code: String(Math.floor(100000 + Math.random() * 900000)), ttlMin: 10, isNew: true });
    const info = (await provider.send({ to: acct.user, ...mail })) as unknown as { response: string; messageId: string };
    console.log(`${GREEN}  ✓ message accepted by server:${RESET} ${info.response}`);

    console.log(`${BOLD}[3/3] Done — view the received mail here:${RESET}`);
    const url = nodemailer.getTestMessageUrl(info as never);
    console.log(`${CYAN}${url}${RESET}`);
    console.log(`\n${GREEN}✅ SMTP path verified end-to-end (resolver → nodemailer → TLS → AUTH → accepted).${RESET}`);
    return;
  }

  // Default: send a real test mail to the given address via current config
  const to = mode;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    console.log(`Usage: bun scripts/test-email.ts <recipient@email>  [--status | --ethereal]`);
    process.exit(1);
  }

  console.log(`${CYAN}resolved provider:${RESET} ${status.provider} — ${status.hint}`);
  if (!hasRealEmailProvider()) {
    console.log(`${RED}✗ No real email provider configured.${RESET}`);
    console.log(`${YELLOW}  Fix (pick ONE, see .env.example §EMAIL):${RESET}`);
    console.log(`  A) RESEND_API_KEY   — https://resend.com → API Keys`);
    console.log(`  B) BREVO_API_KEY    — https://brevo.com → SMTP & API → API Keys (300/day free)`);
    console.log(`  C) SMTP (Gmail app password): SMTP_HOST=smtp.gmail.com SMTP_PORT=465`);
    console.log(`     SMTP_USER=you@gmail.com SMTP_PASS=<16-char app password>`);
    process.exit(1);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const mail = renderEmailOtp({ code, ttlMin: 10, isNew: true });
  console.log(`${BOLD}Sending REAL test mail to ${to} …${RESET}`);
  await getEmailProvider().send({ to, ...mail });
  console.log(`${GREEN}✅ Sent! Check the inbox (and spam folder) of ${to}.${RESET}`);
  console.log(`   The mail contains the standard welcome + activation-code template (test code ${code}).`);
}

main().catch((e) => {
  console.error(`${RED}✗ ${(e as Error).message}${RESET}`);
  process.exit(1);
});
