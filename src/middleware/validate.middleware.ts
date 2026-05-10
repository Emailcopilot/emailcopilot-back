import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

type Target = "body" | "query" | "params";

/**
 * Returns an Express middleware that validates req[target] against the given
 * Zod schema. On success, the parsed (and coerced) value replaces the original
 * so downstream handlers get clean, typed data. On failure, a 400 JSON error
 * with per-field messages is returned immediately.
 */
export function validate(schema: ZodSchema, target: Target = "body") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      res.status(400).json({ error: "Validation failed", details: errors });
      return;
    }
    // Replace with coerced/defaulted values
    (req as any)[target] = result.data;
    next();
  };
}

function formatZodErrors(error: ZodError): Record<string, string> {
  return error.issues.reduce<Record<string, string>>((acc, issue) => {
    const key = issue.path.join(".") || "root";
    acc[key] = issue.message;
    return acc;
  }, {});
}
