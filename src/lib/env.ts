import "dotenv/config";

// ─── Environment variables ─────────────────────────────────────────────────────
export const NODE_ENV = process.env.NODE_ENV || "development";
export const PORT = process.env.PORT || 3001;
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN?.split(",");
export const DATABASE_URL = process.env.DATABASE_URL!;

export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

export const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:3000";
export const OAUTH_REDIRECT_BASE =
  process.env.OAUTH_REDIRECT_BASE ??
  `http://localhost:${process.env.PORT || 3001}`;

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

export const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID ?? "";
export const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? "";
export const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID ?? "common";
