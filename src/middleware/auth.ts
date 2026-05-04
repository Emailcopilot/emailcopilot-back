import { Request, Response, NextFunction } from "express";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { getAuth } from "@clerk/express";


export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {


  try {
    const { userId } = getAuth(req)

    console.log("requireApiKey middleware - auth object:", userId);
    if (!userId) {
      console.warn("Unauthorized access attempt without user ID");
      res.status(401).json({ error: "Unauthorized: No user ID in auth object" });
      return;
    }

    const user = await db.select().from(users).where(eq(users.clerkId, userId)).then(rows => rows[0]);

    if (!user) return res.status(401).json({ error: "User not found" });

    req.dbUser = user;
    next();
  } catch (err) {
    console.error("Error in requireApiKey middleware:", err);
    next(err);
  }
}
