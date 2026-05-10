import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db } from "../db/drizzle";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

/**
 * Resolves the Clerk session to a DB user and attaches it to req.dbUser.
 * Returns 401 if there is no valid session, 404 if the user record is missing.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId: clerkId } = getAuth(req);
    if (!clerkId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.clerkId, clerkId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    req.dbUser = user;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Authentication error" });
  }
}

/**
 * Lightweight wrapper for routes that only need req.dbUser — skips DB lookup
 * when the user is already attached (e.g. by a parent router middleware).
 */
export function assertUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.dbUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
