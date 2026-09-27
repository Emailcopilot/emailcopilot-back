import { Request, Response, NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
}

/**
 * Central Express error handler. Register this LAST in your app middleware
 * chain with app.use(errorHandler).
 *
 * Usage inside route handlers (services throw, Express 5 forwards to here):
 *   throw new Error("Something went wrong")            -> 500
 *   throw notFound("Lead not found")                   -> 404
 *   throw new HttpError(418, "I'm a teapot")           -> 418
 * (see src/lib/http-error.ts)
 */
export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const status = err.statusCode ?? 500;
  const message = status < 500 ? err.message : "Internal server error";

  if (status >= 500) {
    console.error("Unhandled error:", err);
  }
  console.log(`Responding with error ${status}: ${message}`);

  res.status(status).json({ error: message });
}
