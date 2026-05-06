// /types/express.d.ts
import { AuthObject } from "@clerk/express";

declare global {
    namespace Express {
        interface Request {
            auth: AuthObject & { userId?: string | null };
            // assign user type based on your db schema, e.g.:
            dbUser?: user; // replace 'user' with the actual type of your user object from the database
        }
    }