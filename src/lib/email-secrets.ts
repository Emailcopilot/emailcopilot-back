import { createHmac, timingSafeEqual } from "crypto";
import { decrypt, encrypt } from "./encryption";
import { ENCRYPTION_KEY } from "./env";
import type { EmailAccount } from "../db/schema";

const SECRET_PREFIX = "v1:";

/** Encrypt a secret for storage. No-op for empty values. */
export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(SECRET_PREFIX)) return value;
  return encrypt(value);
}

/**
 * Decrypt a stored secret. Plaintext values (legacy) are returned as-is.
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(SECRET_PREFIX)) return value;
  return decrypt(value);
}

export function sanitizeEmailAccount<T extends Partial<EmailAccount>>(
  account: T,
) {
  const {
    smtpPass: _smtpPass,
    imapPass: _imapPass,
    oauthAccessToken: _access,
    oauthRefreshToken: _refresh,
    ...rest
  } = account as T & {
    smtpPass?: string | null;
    imapPass?: string | null;
    oauthAccessToken?: string | null;
    oauthRefreshToken?: string | null;
  };

  return {
    ...rest,
    hasSmtpPass: Boolean(_smtpPass),
    hasImapPass: Boolean(_imapPass),
    hasOauth: Boolean(_refresh || _access),
    imapConfigured: Boolean(
      account.provider === "gmail" ||
        account.provider === "outlook" ||
        account.imapHost,
    ),
    /** @deprecated Prefer smtpStatus / imapStatus */
    status: account.smtpStatus ?? "inactive",
  };
}

export type OAuthProvider = "gmail" | "outlook";

export interface OAuthStatePayload {
  userId: number;
  provider: OAuthProvider;
  nonce: string;
  exp: number;
  /** Frontend path to land on after OAuth (e.g. /dashboard/settings). */
  returnTo?: string;
}

function stateSecret(): string {
  if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is not configured");
  }
  return ENCRYPTION_KEY;
}

export function signOAuthState(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  const [body, sig] = state.split(".");
  if (!body || !sig) {
    throw Object.assign(new Error("Invalid OAuth state"), { statusCode: 400 });
  }

  const expected = createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Invalid OAuth state signature"), {
      statusCode: 400,
    });
  }

  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as OAuthStatePayload;

  if (!payload.exp || Date.now() > payload.exp) {
    throw Object.assign(new Error("OAuth state expired"), { statusCode: 400 });
  }

  return payload;
}

export const PROVIDER_PRESETS = {
  gmail: {
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    imapHost: "imap.gmail.com",
    imapPort: 993,
  },
  outlook: {
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    imapHost: "outlook.office365.com",
    imapPort: 993,
  },
} as const;
