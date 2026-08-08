// /types/express.d.ts
import { AuthObject } from "@clerk/express";
import type { usersTable } from "../db/schema";

type DbUser = typeof usersTable.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      auth: AuthObject & { userId?: string | null };
      dbUser?: DbUser;
    }
  }
}

export {};
