// /types/express.d.ts
import { AuthObject } from "@clerk/express";

declare global {
    namespace Express {
        interface Request {
            auth: AuthObject & { userId?: string | null };
            dbUser: {
                id: number;
                clerkId: string;
                email: string;
            };
        }
    }
}