import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_TENANT_ID,
  OAUTH_REDIRECT_BASE,
  FRONTEND_URL,
} from "../lib/env";
import {
  decryptSecret,
  encryptSecret,
  PROVIDER_PRESETS,
  signOAuthState,
  verifyOAuthState,
  type OAuthProvider,
} from "../lib/email-secrets";
import { db } from "../db/drizzle";
import { emailAccountTable, type EmailAccount } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import type { Request, Response } from "express";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const MS_AUTH_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://mail.google.com/",
].join(" ");

// Do not mix graph.microsoft.com with outlook.office.com — AADSTS70011.
// Profile/email come from the OIDC id_token instead of Graph /me.
const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "https://outlook.office.com/SMTP.Send",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri(provider: OAuthProvider): string {
  return `${OAUTH_REDIRECT_BASE}/email-accounts/oauth/${provider}/callback`;
}

function assertGoogleConfigured() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw Object.assign(
      new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID/SECRET)"),
      { statusCode: 503 },
    );
  }
}

function assertMicrosoftConfigured() {
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw Object.assign(
      new Error(
        "Microsoft OAuth is not configured (MICROSOFT_CLIENT_ID/SECRET)",
      ),
      { statusCode: 503 },
    );
  }
}

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  userId: number,
): string {
  const state = signOAuthState({
    userId,
    provider,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  });

  if (provider === "gmail") {
    assertGoogleConfigured();
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri("gmail"),
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  assertMicrosoftConfigured();
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    redirect_uri: redirectUri("outlook"),
    response_type: "code",
    scope: MICROSOFT_SCOPES,
    response_mode: "query",
    state,
  });
  return `${MS_AUTH_URL(MICROSOFT_TENANT_ID)}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

async function exchangeGoogleCode(code: string): Promise<TokenResponse> {
  assertGoogleConfigured();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri("gmail"),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

async function exchangeMicrosoftCode(code: string): Promise<TokenResponse> {
  assertMicrosoftConfigured();
  const res = await fetch(MS_TOKEN_URL(MICROSOFT_TENANT_ID), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      redirect_uri: redirectUri("outlook"),
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange failed: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

async function fetchGoogleEmail(accessToken: string): Promise<{
  email: string;
  name?: string;
}> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch Google user info");
  }
  const data = (await res.json()) as { email?: string; name?: string };
  if (!data.email) throw new Error("Google account has no email");
  return { email: data.email, name: data.name };
}

async function fetchMicrosoftEmail(tokens: TokenResponse): Promise<{
  email: string;
  name?: string;
}> {
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString(
          "utf8",
        ),
      ) as {
        email?: string;
        preferred_username?: string;
        upn?: string;
        name?: string;
      };
      const email =
        payload.email || payload.preferred_username || payload.upn;
      if (email) {
        return { email, name: payload.name };
      }
    } catch {
      // fall through
    }
  }

  // Fallback: Outlook REST (same resource audience as SMTP/IMAP scopes)
  const res = await fetch("https://outlook.office.com/api/v2.0/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch Microsoft user profile");
  }
  const data = (await res.json()) as {
    EmailAddress?: string;
    DisplayName?: string;
  };
  if (!data.EmailAddress) throw new Error("Microsoft account has no email");
  return { email: data.EmailAddress, name: data.DisplayName };
}

export async function refreshAccessToken(
  account: EmailAccount,
): Promise<EmailAccount> {
  const refreshToken = decryptSecret(account.oauthRefreshToken);
  if (!refreshToken) {
    throw new Error("Email account has no OAuth refresh token");
  }

  let tokens: TokenResponse;

  if (account.provider === "gmail") {
    assertGoogleConfigured();
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      await markAccountError(account.id);
      throw new Error(`Google token refresh failed: ${text}`);
    }
    tokens = (await res.json()) as TokenResponse;
  } else if (account.provider === "outlook") {
    assertMicrosoftConfigured();
    const res = await fetch(MS_TOKEN_URL(MICROSOFT_TENANT_ID), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: MICROSOFT_SCOPES,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      await markAccountError(account.id);
      throw new Error(`Microsoft token refresh failed: ${text}`);
    }
    tokens = (await res.json()) as TokenResponse;
  } else {
    throw new Error("SMTP accounts do not use OAuth refresh");
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  const [updated] = await db
    .update(emailAccountTable)
    .set({
      oauthAccessToken: encryptSecret(tokens.access_token),
      oauthRefreshToken: tokens.refresh_token
        ? encryptSecret(tokens.refresh_token)
        : account.oauthRefreshToken,
      oauthExpiresAt: expiresAt,
      oauthScopes: tokens.scope ?? account.oauthScopes,
      updatedAt: new Date(),
    })
    .where(eq(emailAccountTable.id, account.id))
    .returning();

  return updated ?? account;
}

async function markAccountError(accountId: number) {
  await db
    .update(emailAccountTable)
    .set({
      smtpStatus: "error",
      imapStatus: "error",
      lastSmtpError: "OAuth token refresh failed",
      lastImapError: "OAuth token refresh failed",
      updatedAt: new Date(),
    })
    .where(eq(emailAccountTable.id, accountId));
}

/** Ensure access token is valid; refresh if expired within 2 minutes. */
export async function ensureFreshAccessToken(
  account: EmailAccount,
): Promise<EmailAccount> {
  if (account.provider === "smtp") return account;

  const expiresAt = account.oauthExpiresAt?.getTime() ?? 0;
  const needsRefresh =
    !account.oauthAccessToken || expiresAt < Date.now() + 2 * 60 * 1000;

  if (!needsRefresh) return account;
  return refreshAccessToken(account);
}

async function upsertOAuthAccount(params: {
  userId: number;
  provider: OAuthProvider;
  email: string;
  name?: string;
  tokens: TokenResponse;
}): Promise<EmailAccount> {
  const preset = PROVIDER_PRESETS[params.provider];
  const expiresAt = params.tokens.expires_in
    ? new Date(Date.now() + params.tokens.expires_in * 1000)
    : null;

  const values = {
    profileName: params.name?.slice(0, 100) || params.email,
    email: params.email,
    sendName: params.name?.slice(0, 100) || params.email,
    provider: params.provider,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    oauthAccessToken: encryptSecret(params.tokens.access_token),
    oauthRefreshToken: params.tokens.refresh_token
      ? encryptSecret(params.tokens.refresh_token)
      : null,
    oauthExpiresAt: expiresAt,
    oauthScopes: params.tokens.scope ?? null,
    smtpStatus: "active" as const,
    imapStatus: "active" as const,
    lastSmtpError: null,
    lastImapError: null,
    lastVerifiedAt: new Date(),
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select()
    .from(emailAccountTable)
    .where(
      and(
        eq(emailAccountTable.userId, params.userId),
        eq(emailAccountTable.email, params.email),
        eq(emailAccountTable.provider, params.provider),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(emailAccountTable)
      .set({
        ...values,
        // Keep existing refresh token if provider omitted a new one
        oauthRefreshToken:
          values.oauthRefreshToken ?? existing.oauthRefreshToken,
      })
      .where(eq(emailAccountTable.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(emailAccountTable)
    .values({
      ...values,
      userId: params.userId,
    })
    .returning();
  return created!;
}

function frontendRedirect(query: Record<string, string>): string {
  const url = new URL("/settings/email-accounts", FRONTEND_URL);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function startOAuth(req: Request, res: Response) {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "gmail" && provider !== "outlook") {
    throw Object.assign(new Error("Unsupported OAuth provider"), {
      statusCode: 400,
    });
  }

  const authUrl = buildAuthorizeUrl(provider, req.dbUser!.id);
  res.json({ authUrl });
}

export async function handleOAuthCallback(req: Request, res: Response) {
  const provider = req.params.provider as OAuthProvider;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const error =
    typeof req.query.error === "string" ? req.query.error : null;

  if (error) {
    res.redirect(
      frontendRedirect({ connected: "0", error, provider }),
    );
    return;
  }

  if (!code || !state) {
    res.redirect(
      frontendRedirect({
        connected: "0",
        error: "missing_code_or_state",
        provider,
      }),
    );
    return;
  }

  try {
    const payload = verifyOAuthState(state);
    if (payload.provider !== provider) {
      throw new Error("OAuth provider mismatch");
    }

    const tokens =
      provider === "gmail"
        ? await exchangeGoogleCode(code)
        : await exchangeMicrosoftCode(code);

    const profile =
      provider === "gmail"
        ? await fetchGoogleEmail(tokens.access_token)
        : await fetchMicrosoftEmail(tokens);

    if (!tokens.refresh_token) {
      // May happen on re-consent; still try upsert with access token only
      console.warn(
        `OAuth ${provider}: no refresh_token returned for ${profile.email}`,
      );
    }

    const account = await upsertOAuthAccount({
      userId: payload.userId,
      provider,
      email: profile.email,
      name: profile.name,
      tokens,
    });

    res.redirect(
      frontendRedirect({
        connected: "1",
        provider,
        accountId: String(account.id),
      }),
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    const message = err instanceof Error ? err.message : "oauth_failed";
    res.redirect(
      frontendRedirect({
        connected: "0",
        error: message.slice(0, 200),
        provider,
      }),
    );
  }
}
