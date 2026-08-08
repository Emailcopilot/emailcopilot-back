// /types/express.d.ts
import { AuthObject } from "@clerk/express";
import type { users } from "../db/schema";

type DbUser = typeof users.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      auth: AuthObject & { userId?: string | null };
      dbUser?: DbUser;
    }
  }
}

export {};
