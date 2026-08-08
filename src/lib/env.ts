import "dotenv/config";

// ─── Environment variables ─────────────────────────────────────────────────────
export const NODE_ENV = process.env.NODE_ENV || "development";
export const PORT = process.env.PORT || 3001;
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN?.split(",");
export const DATABASE_URL = process.env.DATABASE_URL!;

export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
