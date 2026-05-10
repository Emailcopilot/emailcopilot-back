import { Request, Response, NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
}

/**
 * Central Express error handler. Register this LAST in your app middleware
 * chain with app.use(errorHandler).
 *
 * Usage inside route handlers:
 *   return next(new Error("Something went wrong"))
 * Or for custom status codes:
 *   const err: AppError = new Error("Not found"); err.statusCode = 404; next(err);
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
