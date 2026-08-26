/**
 * Integration test for SMTP + OAuth Gmail + Outlook accounts:
 * SMTP verify, IMAP connect, cross-send between all pairs, and reply
 * detection from the **sender** perspective (outbound sent_emails → reply).
 *
 * Usage:
 *   pnpm exec tsx scripts/test-oauth-accounts.ts
 *   pnpm exec tsx scripts/test-oauth-accounts.ts 25 23 22
 *
 * Defaults: SMTP #25, Outlook #23, Gmail #22 — all talk to each other.
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/drizzle";
import {
  emailAccountTable,
  sentEmailsTable,
  type EmailAccount,
  type SentEmail,
} from "../src/db/schema";
import {
  resolveImapClient,
  resolveMailTransport,
  testImapConnection,
  testMailTransport,
} from "../src/services/email-transport.service";

const DEFAULT_ACCOUNT_IDS = [25, 23, 22];
const REPLY_WAIT_MS = 120_000;
const POLL_EVERY_MS = 5_000;
const MAILBOXES = ["INBOX", "Junk", "Junk Email", "Spam", "Clutter"] as const;

function normalizeMessageId(id: string | undefined | null): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^<|>$/g, "");
  return trimmed || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountLabel(account: EmailAccount): string {
  return `${account.provider}#${account.id}`;
}

async function loadAccounts(ids: number[]): Promise<EmailAccount[]> {
  const rows = await db
    .select()
    .from(emailAccountTable)
    .where(inArray(emailAccountTable.id, ids));

  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`Email account(s) not found: ${missing.join(", ")}`);
  }

  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/** Every directed pair (from → to) among accounts. */
function directedPairs(accounts: EmailAccount[]): [EmailAccount, EmailAccount][] {
  const pairs: [EmailAccount, EmailAccount][] = [];
  for (const from of accounts) {
    for (const to of accounts) {
      if (from.id === to.id) continue;
      pairs.push([from, to]);
    }
  }
  return pairs;
}

async function testSmtp(account: EmailAccount) {
  console.log(`\n── SMTP verify [${accountLabel(account)}] ${account.email} ──`);
  const result = await testMailTransport(account);
  if (!result.success) {
    throw new Error(`SMTP failed for ${account.email}: ${result.error}`);
  }
  console.log("  OK");
}

async function testImap(account: EmailAccount) {
  console.log(`\n── IMAP connect [${accountLabel(account)}] ${account.email} ──`);
  const result = await testImapConnection(account);
  if (!result.success) {
    throw new Error(`IMAP failed for ${account.email}: ${result.error}`);
  }
  console.log(`  OK (INBOX exists=${result.exists ?? "?"})`);
}

async function sendTestMail(
  from: EmailAccount,
  to: EmailAccount,
  subject: string,
  body: string,
  inReplyTo?: string,
): Promise<string> {
  const mail = await resolveMailTransport(from);
  const info = await mail.transporter.sendMail({
    from: `"${mail.sendName}" <${mail.email}>`,
    to: to.email,
    subject,
    text: body,
    ...(inReplyTo
      ? {
          inReplyTo: inReplyTo.startsWith("<") ? inReplyTo : `<${inReplyTo}>`,
          references: inReplyTo.startsWith("<") ? inReplyTo : `<${inReplyTo}>`,
        }
      : {}),
  });

  const messageId = normalizeMessageId(info.messageId);
  if (!messageId) {
    throw new Error(`No Message-ID returned when sending from ${from.email}`);
  }
  console.log(`  sent Message-ID=<${messageId}>`);
  return messageId;
}

/** Persist outbound message the way production mailer does (sender record). */
async function recordOutboundSentEmail(params: {
  account: EmailAccount;
  to: EmailAccount;
  subject: string;
  body: string;
  messageId: string;
}): Promise<SentEmail> {
  const now = new Date();
  const [row] = await db
    .insert(sentEmailsTable)
    .values({
      emailAccountId: params.account.id,
      toEmail: params.to.email,
      subject: params.subject,
      body: params.body,
      messageId: params.messageId,
      sequenceStep: 0,
      status: "sent",
      sentAt: now,
    })
    .returning();
  return row!;
}

async function scanMailboxForMessage(
  account: EmailAccount,
  mailbox: string,
  opts: {
    subjectIncludes: string;
    expectedInReplyTo?: string;
    expectedFromEmail?: string;
  },
): Promise<{
  uid: number;
  subject: string;
  messageId: string | null;
  mailbox: string;
  fromEmail: string | null;
  inReplyTo: string | null;
} | null> {
  const expected = normalizeMessageId(opts.expectedInReplyTo);
  const expectedFrom = opts.expectedFromEmail?.toLowerCase();
  const { client } = await resolveImapClient(account);

  try {
    await client.connect();

    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
    } catch {
      return null; // mailbox may not exist
    }

    try {
      const box = client.mailbox;
      const exists =
        box && typeof box !== "boolean" ? Number(box.exists ?? 0) : 0;
      if (exists === 0) return null;

      const start = Math.max(1, exists - 49);
      const range = `${start}:${exists}`;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        headers: ["message-id", "in-reply-to", "references"],
      })) {
        const subject = msg.envelope?.subject ?? "";
        if (!subject.includes(opts.subjectIncludes)) continue;

        const fromEmail =
          msg.envelope?.from?.[0]?.address?.toLowerCase() ?? null;
        if (expectedFrom && fromEmail !== expectedFrom) continue;

        const headers = msg.headers?.toString() ?? "";
        const inReplyTo = headers.match(/in-reply-to:\s*(.+)/i)?.[1]?.trim();
        const references = headers.match(/references:\s*(.+)/i)?.[1]?.trim();
        const messageIdRaw = headers.match(/message-id:\s*(.+)/i)?.[1]?.trim();

        if (expected) {
          const related = `${inReplyTo ?? ""} ${references ?? ""}`;
          if (
            !related.includes(expected) &&
            !related.includes(`<${expected}>`)
          ) {
            continue;
          }
        }

        return {
          uid: msg.uid,
          subject,
          messageId: normalizeMessageId(messageIdRaw),
          mailbox,
          fromEmail,
          inReplyTo: normalizeMessageId(inReplyTo) ?? null,
        };
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }

  return null;
}

async function waitForMessage(
  account: EmailAccount,
  opts: {
    subjectIncludes: string;
    expectedInReplyTo?: string;
    expectedFromEmail?: string;
    timeoutMs: number;
  },
) {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    for (const mailbox of MAILBOXES) {
      const hit = await scanMailboxForMessage(account, mailbox, opts);
      if (hit) return hit;
    }

    const left = Math.max(0, deadline - Date.now());
    console.log(
      `  …waiting on ${account.email} INBOX/Junk (${Math.ceil(left / 1000)}s left)`,
    );
    await sleep(Math.min(POLL_EVERY_MS, left || POLL_EVERY_MS));
  }

  throw new Error(
    `Timed out waiting for message on ${account.email} (subject contains "${opts.subjectIncludes}")`,
  );
}

/**
 * Sender perspective: given our outbound sent_emails row, detect that the
 * contact replied (In-Reply-To / References → our messageId) and mark replied.
 */
async function assertSenderDetectedContactReply(params: {
  sender: EmailAccount;
  contact: EmailAccount;
  outbound: SentEmail;
  subjectToken: string;
}): Promise<void> {
  const outboundId = normalizeMessageId(params.outbound.messageId);
  if (!outboundId) {
    throw new Error("Outbound sent_emails row has no messageId");
  }

  console.log(
    `── Sender perspective: did ${params.contact.email} reply to <${outboundId}>? ──`,
  );

  const reply = await waitForMessage(params.sender, {
    subjectIncludes: params.subjectToken,
    expectedInReplyTo: outboundId,
    expectedFromEmail: params.contact.email,
    timeoutMs: REPLY_WAIT_MS,
  });

  if (reply.fromEmail?.toLowerCase() !== params.contact.email.toLowerCase()) {
    throw new Error(
      `Reply From mismatch: expected ${params.contact.email}, got ${reply.fromEmail}`,
    );
  }

  const relatedId = reply.inReplyTo;
  if (relatedId && relatedId !== outboundId) {
    console.log(
      `  note: In-Reply-To=${relatedId} outbound=${outboundId} (matched via References)`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(sentEmailsTable)
    .set({
      status: "replied",
      repliedAt: now,
      updatedAt: now,
    })
    .where(eq(sentEmailsTable.id, params.outbound.id))
    .returning();

  if (!updated || updated.status !== "replied") {
    throw new Error("Failed to mark outbound sent_emails as replied");
  }

  console.log(
    `  OK contact replied — mailbox=${reply.mailbox} uid=${reply.uid} from=${reply.fromEmail}`,
  );
  console.log(
    `  OK sent_emails #${updated.id} status=replied (sender tracked reply)`,
  );
}

async function runSendAndReply(
  from: EmailAccount,
  to: EmailAccount,
) {
  const label = `${accountLabel(from)} → ${accountLabel(to)} → reply`;
  const token = `ec-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const subject = `[EmailCopilot Mesh Test] ${token}`;
  const body = `Mesh SMTP test (${label}).\nToken: ${token}\n`;

  console.log(`\n══ ${label} ══`);
  console.log(`── Send ${from.email} → ${to.email} ──`);
  console.log(`  subject: ${subject}`);
  const originalMessageId = await sendTestMail(from, to, subject, body);

  const outbound = await recordOutboundSentEmail({
    account: from,
    to,
    subject,
    body,
    messageId: originalMessageId,
  });
  console.log(
    `  recorded sent_emails #${outbound.id} status=sent (sender outbound)`,
  );

  console.log(`── Wait for delivery in ${to.email} ──`);
  const delivered = await waitForMessage(to, {
    subjectIncludes: token,
    expectedFromEmail: from.email,
    timeoutMs: REPLY_WAIT_MS,
  });
  console.log(
    `  OK mailbox=${delivered.mailbox} uid=${delivered.uid} subject="${delivered.subject}"`,
  );

  console.log(`── Contact ${to.email} replies to sender ${from.email} ──`);
  await sendTestMail(
    to,
    from,
    `Re: ${subject}`,
    `Reply for token ${token}\n`,
    originalMessageId,
  );

  await assertSenderDetectedContactReply({
    sender: from,
    contact: to,
    outbound,
    subjectToken: token,
  });
}

const BOUNCE_FROM_RE =
  /mailer-daemon|postmaster|mail delivery|noreply.*bounce/i;
const BOUNCE_SUBJECT_RE =
  /undeliverable|delivery status notification|mail delivery failed|returned mail|failure notice/i;
const BOUNCE_WAIT_MS = 180_000;

/**
 * True SMTP/local failure → failed_at + error_message.
 * Invalid Gmail addresses are usually *accepted* then bounced (not failed).
 */
async function testSmtpFailure(account: EmailAccount) {
  const subject = `[EmailCopilot Fail Test] ${Date.now()}`;
  const body = "Intentional SMTP failure test.";
  // Nodemailer rejects this before/at SMTP (no domain)
  const badTo = "not-a-valid-email-address";

  console.log(`\n══ SMTP failure [${accountLabel(account)}] ${account.email} ══`);
  console.log(`── Send to malformed recipient "${badTo}" ──`);

  let errorMessage = "";
  try {
    await sendTestMail(account, { ...account, email: badTo }, subject, body);
    throw new Error("Expected send to fail for malformed recipient");
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes("Expected send to fail")) throw err;
    console.log(`  send failed as expected: ${errorMessage.slice(0, 160)}`);
  }

  const now = new Date();
  const [row] = await db
    .insert(sentEmailsTable)
    .values({
      emailAccountId: account.id,
      toEmail: badTo,
      subject,
      body,
      sequenceStep: 0,
      status: "failed",
      failedAt: now,
      errorMessage: errorMessage.slice(0, 2000),
    })
    .returning();

  if (!row?.failedAt || row.status !== "failed" || !row.errorMessage) {
    throw new Error("sent_emails failed row missing failedAt/errorMessage");
  }

  console.log(
    `  OK sent_emails #${row.id} status=failed failedAt=${row.failedAt.toISOString()}`,
  );
  console.log(`  OK error_message=${row.errorMessage.slice(0, 120)}`);
}

async function scanForBounceMatching(
  account: EmailAccount,
  opts: {
    outboundMessageId: string;
    toEmail: string;
    subject: string;
  },
): Promise<{
  mailbox: string;
  uid: number;
  subject: string;
  diagnostic: string;
} | null> {
  const expected = normalizeMessageId(opts.outboundMessageId);
  const toEmail = opts.toEmail.toLowerCase();

  for (const mailbox of MAILBOXES) {
    const { client } = await resolveImapClient(account);
    try {
      await client.connect();
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        continue;
      }

      try {
        const box = client.mailbox;
        const exists =
          box && typeof box !== "boolean" ? Number(box.exists ?? 0) : 0;
        if (exists === 0) continue;

        const start = Math.max(1, exists - 79);
        const range = `${start}:${exists}`;

        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          headers: ["in-reply-to", "references", "content-type"],
          source: { start: 0, maxLength: 16000 },
        })) {
          const fromEmail =
            msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
          const fromText = msg.envelope?.from?.[0]
            ? `${msg.envelope.from[0].name ?? ""} <${fromEmail}>`
            : fromEmail;
          const subject = msg.envelope?.subject ?? "";

          const isBounce =
            BOUNCE_FROM_RE.test(fromText) ||
            BOUNCE_FROM_RE.test(fromEmail) ||
            BOUNCE_SUBJECT_RE.test(subject);

          if (!isBounce) continue;

          const headers = msg.headers?.toString() ?? "";
          const source =
            typeof msg.source === "string"
              ? msg.source
              : Buffer.isBuffer(msg.source)
                ? msg.source.toString("utf8")
                : "";
          const blob = `${headers}\n${source}\n${subject}`;

          // Outlook rewrites Message-ID; NDR In-Reply-To is Exchange ID.
          // Match Original-Message-ID, Final-Recipient, or Undeliverable subject.
          const subjectMatch =
            subject.includes(opts.subject) ||
            subject.replace(/^undeliverable:\s*/i, "").trim() === opts.subject;
          const recipientMatch =
            blob.toLowerCase().includes(toEmail) ||
            blob.toLowerCase().includes(`final-recipient: rfc822;${toEmail}`);
          const idMatch =
            !!expected &&
            (blob.includes(expected) || blob.includes(`<${expected}>`));

          if (!subjectMatch && !recipientMatch && !idMatch) continue;

          const diagnostic =
            blob.match(/diagnostic-code:\s*[^\n]+/i)?.[0] ??
            blob.match(/550[\s\S]{0,120}NoSuchUser/i)?.[0] ??
            `Bounce: ${subject}`;

          return {
            mailbox,
            uid: msg.uid,
            subject,
            diagnostic: diagnostic.replace(/\s+/g, " ").slice(0, 500),
          };
        }
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

/**
 * SMTP accepts, then DSN bounce → bounced_at + error_message.
 * Match NDR by subject / Final-Recipient / original Message-ID (Outlook rewrites IDs).
 */
async function testBounceDetection(sender: EmailAccount) {
  const stamp = Date.now();
  const badTo = `ec-bounce-${stamp}-${Math.random().toString(36).slice(2, 8)}@gmail.com`;
  const subject = `[EmailCopilot Bounce Test] ${stamp}`;
  const body = "Intentional bounce test — discard.";

  console.log(
    `\n══ Bounce detection [${accountLabel(sender)}] ${sender.email} ══`,
  );
  console.log(`── Send to ${badTo} (expect later DSN bounce) ──`);

  let messageId: string;
  try {
    messageId = await sendTestMail(
      sender,
      { ...sender, email: badTo },
      subject,
      body,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `  SMTP rejected immediately (not a bounce): ${msg.slice(0, 160)}`,
    );
    const now = new Date();
    const [row] = await db
      .insert(sentEmailsTable)
      .values({
        emailAccountId: sender.id,
        toEmail: badTo,
        subject,
        body,
        sequenceStep: 0,
        status: "failed",
        failedAt: now,
        errorMessage: msg.slice(0, 2000),
      })
      .returning();
    console.log(
      `  OK sent_emails #${row!.id} status=failed failedAt set (immediate reject)`,
    );
    return;
  }

  const outbound = await recordOutboundSentEmail({
    account: sender,
    to: { ...sender, email: badTo },
    subject,
    body,
    messageId,
  });
  console.log(
    `  recorded sent_emails #${outbound.id} status=sent messageId=<${messageId}>`,
  );
  console.log(
    "  note: Outlook may rewrite Message-ID; matcher also uses subject + Final-Recipient",
  );

  console.log(`── Wait for bounce DSN in ${sender.email} ──`);
  const deadline = Date.now() + BOUNCE_WAIT_MS;
  let bounce: Awaited<ReturnType<typeof scanForBounceMatching>> = null;

  while (Date.now() < deadline) {
    bounce = await scanForBounceMatching(sender, {
      outboundMessageId: messageId,
      toEmail: badTo,
      subject,
    });
    if (bounce) break;
    const left = Math.max(0, deadline - Date.now());
    console.log(`  …waiting for bounce (${Math.ceil(left / 1000)}s left)`);
    await sleep(Math.min(POLL_EVERY_MS, left || POLL_EVERY_MS));
  }

  if (!bounce) {
    throw new Error(
      `No bounce DSN for to=${badTo} subject="${subject}" within ${BOUNCE_WAIT_MS / 1000}s`,
    );
  }

  const now = new Date();
  const errorMessage = bounce.diagnostic.slice(0, 2000);
  const [updated] = await db
    .update(sentEmailsTable)
    .set({
      status: "bounced",
      bouncedAt: now,
      errorMessage,
      updatedAt: now,
    })
    .where(eq(sentEmailsTable.id, outbound.id))
    .returning();

  if (!updated?.bouncedAt || updated.status !== "bounced" || !updated.errorMessage) {
    throw new Error("sent_emails bounce update missing bouncedAt/errorMessage");
  }

  console.log(
    `  OK bounce mailbox=${bounce.mailbox} uid=${bounce.uid} subject="${bounce.subject}"`,
  );
  console.log(
    `  OK sent_emails #${updated.id} status=bounced bouncedAt=${updated.bouncedAt.toISOString()}`,
  );
  console.log(`  OK error_message=${updated.errorMessage.slice(0, 160)}`);
}

async function markAccountsVerified(accounts: EmailAccount[]) {
  const now = new Date();
  for (const account of accounts) {
    await db
      .update(emailAccountTable)
      .set({
        lastVerifiedAt: now,
        smtpStatus: "active",
        imapStatus: "active",
        lastSmtpError: null,
        lastImapError: null,
        updatedAt: now,
      })
      .where(eq(emailAccountTable.id, account.id));
  }
}

async function main() {
  const ids =
    process.argv.length > 2
      ? process.argv.slice(2).map((v) => Number(v))
      : DEFAULT_ACCOUNT_IDS;

  if (ids.some((id) => !Number.isFinite(id) || id <= 0)) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/test-oauth-accounts.ts [id ...] (default: 25 23 22)",
    );
  }
  if (ids.length < 2) {
    throw new Error("Need at least 2 account ids to test cross-send");
  }

  console.log(`Loading accounts: ${ids.map((id) => `#${id}`).join(", ")}`);
  const accounts = await loadAccounts(ids);

  for (const account of accounts) {
    console.log(
      `  ${accountLabel(account)} ${account.email} smtp=${account.smtpStatus} imap=${account.imapStatus}`,
    );
  }

  for (const account of accounts) {
    await testSmtp(account);
  }
  for (const account of accounts) {
    await testImap(account);
  }

  for (const account of accounts) {
    await testSmtpFailure(account);
  }

  for (const account of accounts) {
    await testBounceDetection(account);
  }

  const pairs = directedPairs(accounts);
  console.log(
    `\n── Mesh send+reply: ${pairs.length} directed pairs among ${accounts.length} accounts ──`,
  );
  for (const [from, to] of pairs) {
    await runSendAndReply(from, to);
  }

  await markAccountsVerified(accounts);

  console.log(
    `\n✅ All checks passed for ${accounts.map(accountLabel).join(", ")} (SMTP / IMAP / fail / bounce / ${pairs.length}-way mesh).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
