import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { ImapFlow } from "imapflow";
import type { EmailAccount } from "../db/schema";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
} from "../lib/env";
import { decryptSecret, PROVIDER_PRESETS } from "../lib/email-secrets";
import { ensureFreshAccessToken } from "./email-oauth.service";

export interface MailTransportConfig {
  account: EmailAccount;
  host: string;
  port: number;
  email: string;
  sendName: string;
  transporter: nodemailer.Transporter;
  accessToken?: string;
}

export async function resolveMailTransport(
  account: EmailAccount,
): Promise<MailTransportConfig> {
  const sendName = account.sendName ?? account.email;

  if (account.provider === "gmail" || account.provider === "outlook") {
    const fresh = await ensureFreshAccessToken(account);
    const accessToken = decryptSecret(fresh.oauthAccessToken);
    const refreshToken = decryptSecret(fresh.oauthRefreshToken);

    if (!accessToken && !refreshToken) {
      throw new Error("OAuth tokens missing for email account");
    }

    const preset = PROVIDER_PRESETS[account.provider];
    const clientId =
      account.provider === "gmail" ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID;
    const clientSecret =
      account.provider === "gmail"
        ? GOOGLE_CLIENT_SECRET
        : MICROSOFT_CLIENT_SECRET;

    const options: SMTPTransport.Options = {
      host: account.smtpHost ?? preset.smtpHost,
      port: account.smtpPort ?? preset.smtpPort,
      secure: (account.smtpPort ?? preset.smtpPort) === 465,
      auth: {
        type: "OAuth2",
        user: fresh.email,
        clientId,
        clientSecret,
        refreshToken: refreshToken ?? undefined,
        accessToken: accessToken ?? undefined,
      },
    };

    return {
      account: fresh,
      host: options.host!,
      port: options.port!,
      email: fresh.email,
      sendName,
      accessToken: accessToken ?? undefined,
      transporter: nodemailer.createTransport(options),
    };
  }

  const pass = account.smtpPass;
  if (!account.smtpHost || !account.email || !pass) {
    throw new Error(
      "SMTP configuration incomplete. smtpHost, email, and smtpPass are required.",
    );
  }

  const port = account.smtpPort ?? 587;
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port,
    secure: port === 465,
    auth: { user: account.email, pass },
  });

  return {
    account,
    host: account.smtpHost,
    port,
    email: account.email,
    sendName,
    transporter,
  };
}

export async function resolveImapClient(
  account: EmailAccount,
): Promise<{ client: ImapFlow; account: EmailAccount }> {
  if (account.provider === "gmail" || account.provider === "outlook") {
    const fresh = await ensureFreshAccessToken(account);
    const accessToken = decryptSecret(fresh.oauthAccessToken);
    if (!accessToken) {
      throw new Error("Missing OAuth access token for IMAP");
    }

    const preset = PROVIDER_PRESETS[account.provider];
    const client = new ImapFlow({
      host: account.imapHost ?? preset.imapHost,
      port: account.imapPort ?? preset.imapPort,
      secure: true,
      auth: {
        user: fresh.email,
        accessToken,
      },
      logger: false,
    });
    return { client, account: fresh };
  }

  const pass =
    decryptSecret(account.imapPass) ?? account.smtpPass;
  if (!account.imapHost || !pass) {
    throw new Error("IMAP not configured for SMTP account");
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort ?? 993,
    secure: true,
    auth: {
      user: account.email,
      pass,
    },
    logger: false,
  });
  return { client, account };
}

export async function testMailTransport(
  account: EmailAccount,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { transporter } = await resolveMailTransport(account);
    await transporter.verify();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function testImapConnection(
  account: EmailAccount,
): Promise<{ success: boolean; error?: string; exists?: number }> {
  let client: ImapFlow | null = null;
  try {
    const resolved = await resolveImapClient(account);
    client = resolved.client;
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      const exists =
        mailbox && typeof mailbox !== "boolean" ? (mailbox.exists ?? 0) : 0;
      return { success: true, exists };
    } finally {
      lock.release();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }
}
