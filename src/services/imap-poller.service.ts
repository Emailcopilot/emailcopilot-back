import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/drizzle";
import {
  copilotsTable,
  copilotLeadsTable,
  emailAccountTable,
  sentEmailsTable,
  type EmailAccount,
} from "../db/schema";
import { resolveImapClient } from "./email-transport.service";

const IDLE_POLL_MS = 90 * 1000;
/** Cap first-sync / catch-up so we never UID FETCH an entire large mailbox. */
const MAX_FETCH_MESSAGES = 100;
const BOUNCE_FROM_RE =
  /mailer-daemon|postmaster|mail delivery|noreply.*bounce/i;

function normalizeMessageId(id: string | undefined | null): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^<|>$/g, "");
}

function extractMessageIds(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/<[^>]+>/g);
  if (matches?.length) {
    return matches.map((m) => normalizeMessageId(m)!).filter(Boolean);
  }
  const single = normalizeMessageId(headerValue);
  return single ? [single] : [];
}

function formatImapError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & {
    responseText?: string;
    responseStatus?: string;
    serverResponseCode?: string;
  };
  const parts = [error.message];
  if (extra.responseStatus) parts.push(`status=${extra.responseStatus}`);
  if (extra.serverResponseCode) parts.push(`code=${extra.serverResponseCode}`);
  if (extra.responseText) parts.push(extra.responseText);
  return parts.join(" | ");
}

async function markBounce(
  sentEmailId: number,
  copilotLeadId: number | null,
  errorMessage?: string,
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(sentEmailsTable)
      .set({
        status: "bounced",
        bouncedAt: now,
        errorMessage: errorMessage?.slice(0, 2000) ?? null,
        updatedAt: now,
      })
      .where(eq(sentEmailsTable.id, sentEmailId));

    if (copilotLeadId) {
      await tx
        .update(copilotLeadsTable)
        .set({
          status: "bounced",
          bouncedAt: now,
          errorMessage: errorMessage?.slice(0, 2000) ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(copilotLeadsTable.id, copilotLeadId),
            inArray(copilotLeadsTable.status, ["new", "sent", "failed"]),
          ),
        );
    }
  });
}

async function markReply(
  sentEmailId: number,
  copilotLeadId: number | null,
  copilotId: number | null,
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(sentEmailsTable)
      .set({
        status: "replied",
        repliedAt: now,
        updatedAt: now,
      })
      .where(eq(sentEmailsTable.id, sentEmailId));

    if (copilotLeadId) {
      const updated = await tx
        .update(copilotLeadsTable)
        .set({
          status: "replied",
          repliedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(copilotLeadsTable.id, copilotLeadId),
            inArray(copilotLeadsTable.status, ["new", "sent", "failed"]),
          ),
        )
        .returning({ id: copilotLeadsTable.id });

      if (updated.length > 0 && copilotId) {
        await tx
          .update(copilotsTable)
          .set({
            emailsReplied: sql`${copilotsTable.emailsReplied} + 1`,
            updatedAt: now,
          })
          .where(eq(copilotsTable.id, copilotId));
      }
    }
  });
}

async function findSentByMessageIds(messageIds: string[]) {
  if (messageIds.length === 0) return null;

  // Match with or without angle brackets in DB
  const variants = messageIds.flatMap((id) => [id, `<${id}>`]);

  for (const variant of variants) {
    const [row] = await db
      .select()
      .from(sentEmailsTable)
      .where(eq(sentEmailsTable.messageId, variant))
      .limit(1);
    if (row) return row;
  }

  // Also try stripping brackets from stored values via normalized compare
  const candidates = await db
    .select()
    .from(sentEmailsTable)
    .where(inArray(sentEmailsTable.status, ["sent", "pending"]));

  const normalizedSet = new Set(messageIds.map((id) => normalizeMessageId(id)));
  return (
    candidates.find((c) => {
      const n = normalizeMessageId(c.messageId);
      return n && normalizedSet.has(n);
    }) ?? null
  );
}

async function findSentByRecipient(
  accountId: number,
  fromEmail: string | undefined,
) {
  if (!fromEmail) return null;
  const email = fromEmail.toLowerCase();
  const [row] = await db
    .select()
    .from(sentEmailsTable)
    .where(
      and(
        eq(sentEmailsTable.emailAccountId, accountId),
        eq(sentEmailsTable.toEmail, email),
        eq(sentEmailsTable.status, "sent"),
      ),
    )
    .orderBy(desc(sentEmailsTable.sentAt))
    .limit(1);
  return row ?? null;
}

/**
 * Outlook/Exchange rewrites Message-ID. NDRs often reference the Exchange ID
 * while we store Nodemailer's X-Microsoft-Original-Message-ID. Match via:
 * message ids in blob, Final-Recipient, or Undeliverable subject suffix.
 */
async function findSentByBounceContent(
  accountId: number,
  subject: string,
  blob: string,
) {
  const ids = [
    ...extractMessageIds(blob.match(/in-reply-to:\s*(.+)/i)?.[1]),
    ...extractMessageIds(blob.match(/references:\s*(.+)/i)?.[1]),
    ...extractMessageIds(
      blob.match(/x-microsoft-original-message-id:\s*(.+)/i)?.[1],
    ),
    ...extractMessageIds(blob.match(/message-id:\s*(.+)/i)?.[1]),
  ];

  const byId = await findSentByMessageIds(ids);
  if (byId && byId.emailAccountId === accountId) return byId;

  const finalRecipient = blob
    .match(/final-recipient:\s*rfc822;\s*([^\s\r\n]+)/i)?.[1]
    ?.trim()
    .toLowerCase();
  if (finalRecipient) {
    const byRecipient = await findSentByRecipient(accountId, finalRecipient);
    if (byRecipient) return byRecipient;
  }

  // "Undeliverable: [EmailCopilot Bounce Test] 123" → match subject suffix
  const originalSubject = subject
    .replace(/^undeliverable:\s*/i, "")
    .replace(/^delivery status notification.*?:\s*/i, "")
    .trim();
  if (originalSubject.length >= 8) {
    const recent = await db
      .select()
      .from(sentEmailsTable)
      .where(
        and(
          eq(sentEmailsTable.emailAccountId, accountId),
          eq(sentEmailsTable.status, "sent"),
        ),
      )
      .orderBy(desc(sentEmailsTable.sentAt))
      .limit(50);

    const hit = recent.find(
      (r) =>
        r.subject === originalSubject ||
        originalSubject.includes(r.subject) ||
        r.subject.includes(originalSubject) ||
        (blob.includes(r.toEmail) &&
          normalizeMessageId(r.messageId) &&
          blob.includes(normalizeMessageId(r.messageId)!)),
    );
    if (hit) return hit;
  }

  // Last resort: original message-id we stored appears anywhere in NDR body
  const candidates = await db
    .select()
    .from(sentEmailsTable)
    .where(
      and(
        eq(sentEmailsTable.emailAccountId, accountId),
        eq(sentEmailsTable.status, "sent"),
      ),
    )
    .orderBy(desc(sentEmailsTable.sentAt))
    .limit(30);

  return (
    candidates.find((c) => {
      const id = normalizeMessageId(c.messageId);
      return (
        id &&
        (blob.includes(id) ||
          blob.includes(`<${id}>`) ||
          blob.toLowerCase().includes(c.toEmail.toLowerCase()))
      );
    }) ?? null
  );
}

async function touchImapOk(accountId: number, imapLastUid?: number) {
  await db
    .update(emailAccountTable)
    .set({
      ...(imapLastUid !== undefined ? { imapLastUid } : {}),
      imapLastSyncedAt: new Date(),
      imapStatus: "active",
      lastImapError: null,
      updatedAt: new Date(),
    })
    .where(eq(emailAccountTable.id, accountId));
}

/**
 * Build a UID range that servers accept. Empty ranges like `N:*` when N is
 * past the mailbox's highest UID make some hosts (cPanel/Dovecot, Outlook)
 * return NO → ImapFlow's vague "Command failed". Verify never FETCHes, so it
 * looks fine while the poller fails.
 */
function resolveFetchRange(
  lastUid: number,
  uidNext: number,
  exists: number,
): { range: string; cursorUid: number; useUid: boolean } | null {
  const highestUid = Math.max(0, uidNext - 1);

  // Already caught up — nothing to fetch
  if (lastUid > 0 && lastUid >= highestUid) {
    return null;
  }

  // Stale cursor (mailbox rebuilt / UIDVALIDITY change) → recent tail only
  let fromUid = lastUid > 0 ? lastUid + 1 : 0;
  if (fromUid > highestUid) {
    fromUid = 0;
  }

  if (fromUid === 0) {
    // First sync or reset: sequence-number window for the newest messages
    if (exists === 0) return null;
    const startSeq = Math.max(1, exists - MAX_FETCH_MESSAGES + 1);
    return { range: `${startSeq}:*`, cursorUid: lastUid, useUid: false };
  }

  // Incremental: must use UID FETCH — imapLastUid is a UID, not a seq number.
  // Passing it as a sequence (ImapFlow default) is what caused "Command failed"
  // while verify (SELECT only) still succeeded.
  return { range: `${fromUid}:*`, cursorUid: lastUid, useUid: true };
}

async function processAccount(account: EmailAccount): Promise<void> {
  if (account.imapStatus === "disabled") return;

  const needsImap =
    account.provider === "gmail" ||
    account.provider === "outlook" ||
    Boolean(account.imapHost);

  if (!needsImap) return;

  const { client } = await resolveImapClient(account);

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") return;

      const exists = Number(mailbox.exists ?? 0);
      const uidNext = Number(mailbox.uidNext ?? 1);
      const lastUid = account.imapLastUid ?? 0;

      const fetchPlan = resolveFetchRange(lastUid, uidNext, exists);
      if (!fetchPlan) {
        await touchImapOk(account.id, Math.max(lastUid, uidNext - 1));
        return;
      }

      let maxUid = fetchPlan.cursorUid;

      for await (const msg of client.fetch(
        fetchPlan.range,
        {
          uid: true,
          envelope: true,
          headers: ["in-reply-to", "references", "content-type"],
          source: { start: 0, maxLength: 12000 },
        },
        { uid: fetchPlan.useUid },
      )) {
        if (msg.uid > maxUid) maxUid = msg.uid;

        const fromText = msg.envelope?.from?.[0]
          ? `${msg.envelope.from[0].name ?? ""} <${msg.envelope.from[0].address ?? ""}>`
          : undefined;
        const fromEmail = msg.envelope?.from?.[0]?.address?.toLowerCase();
        const subject = msg.envelope?.subject ?? "";

        const inReplyToHeader = msg.headers
          ?.toString()
          ?.match(/in-reply-to:\s*(.+)/i)?.[1]
          ?.trim();
        const referencesHeader = msg.headers
          ?.toString()
          ?.match(/references:\s*(.+)/i)?.[1]
          ?.trim();

        const relatedIds = [
          ...extractMessageIds(inReplyToHeader),
          ...extractMessageIds(referencesHeader),
        ];

        const source =
          typeof msg.source === "string"
            ? msg.source
            : Buffer.isBuffer(msg.source)
              ? msg.source.toString("utf8")
              : "";
        const blob = `${msg.headers?.toString() ?? ""}\n${source}`;

        const isBounce =
          BOUNCE_FROM_RE.test(fromText ?? "") ||
          BOUNCE_FROM_RE.test(fromEmail ?? "") ||
          /undeliverable|delivery status notification|mail delivery failed/i.test(
            subject,
          );

        if (isBounce) {
          const matched =
            (await findSentByMessageIds(relatedIds)) ??
            (await findSentByBounceContent(account.id, subject, blob));
          if (matched && matched.status !== "bounced") {
            const diagnostic =
              blob.match(/diagnostic-code:\s*[^\n]+/i)?.[0] ??
              `Bounce: ${subject}`;
            await markBounce(
              matched.id,
              matched.copilotLeadId,
              diagnostic.slice(0, 2000),
            );
            console.log(
              `📭 Bounce detected for sent_email ${matched.id} (${matched.toEmail})`,
            );
          }
          continue;
        }

        if (relatedIds.length > 0) {
          const matched = await findSentByMessageIds(relatedIds);
          if (matched && matched.status === "sent") {
            await markReply(matched.id, matched.copilotLeadId, matched.copilotId);
            console.log(
              `💬 Reply detected for sent_email ${matched.id} (${matched.toEmail})`,
            );
            continue;
          }
        }

        // Fallback: From matches a recent recipient
        const byFrom = await findSentByRecipient(account.id, fromEmail);
        if (byFrom && byFrom.status === "sent") {
          await markReply(byFrom.id, byFrom.copilotLeadId, byFrom.copilotId);
          console.log(
            `💬 Reply (from-match) for sent_email ${byFrom.id} (${byFrom.toEmail})`,
          );
        }
      }

      await touchImapOk(
        account.id,
        Math.max(maxUid, uidNext - 1, lastUid),
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    console.error(
      `❌ IMAP poll failed for account ${account.id}:`,
      formatImapError(error),
    );
    await db
      .update(emailAccountTable)
      .set({
        imapStatus: "error",
        lastImapError: formatImapError(error).slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(emailAccountTable.id, account.id));
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

async function pollAllAccounts(): Promise<void> {
  const accounts = await db
    .select()
    .from(emailAccountTable)
    .where(inArray(emailAccountTable.imapStatus, ["active", "error", "inactive"]));

  for (const account of accounts) {
    try {
      await processAccount(account);
    } catch (error) {
      console.error(`❌ IMAP account ${account.id} error:`, formatImapError(error));
    }
  }
}

export function periodicImapPoller() {
  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        await pollAllAccounts();
      } catch (error) {
        console.error("❌ IMAP poller error:", error);
      } finally {
        scheduleNext();
      }
    }, IDLE_POLL_MS);
  };

  pollAllAccounts()
    .catch((error) => console.error("❌ IMAP poller error:", error))
    .finally(() => scheduleNext());
}
