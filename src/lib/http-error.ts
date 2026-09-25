/**
 * Error carrying an HTTP status code.
 *
 * Throw it from route handlers/services; the central `errorHandler`
 * middleware reads `statusCode` and responds with that status
 * (messages are only surfaced for status < 500).
 *
 *   throw notFound("Lead not found");
 *   throw new HttpError(418, "I'm a teapot");
 */

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

/** 400 */
export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

/** 403 */
export function forbidden(message: string): HttpError {
  return new HttpError(403, message);
}

/** 404 */
export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** 503 */
export function serviceUnavailable(message: string): HttpError {
  return new HttpError(503, message);
}
