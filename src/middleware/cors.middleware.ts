import cors from "cors";

const allowedOrigins =
  process.env.ALLOWED_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? ["http://localhost:3000"];

export const corsMiddleware = cors({
  origin: (requestOrigin, callback) => {
    if (!requestOrigin) return callback(null, true);
    if (allowedOrigins.includes(requestOrigin)) return callback(null, true);

    try {
      if (new URL(requestOrigin).hostname.endsWith(".vercel.app")) {
        return callback(null, true);
      }
    } catch {
      // Fall through to rejection below.
    }

    callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
  },
  credentials: true,
});
