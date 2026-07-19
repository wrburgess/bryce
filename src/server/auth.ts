import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Bearer-token middleware for /api/* and /mcp (rules/security.md: deny by
 * default, fail closed). The comparison is constant-time over SHA-256 digests
 * so neither token length nor prefix leaks through timing; the 401 body is a
 * fixed string and the token is never echoed or logged.
 */

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export function bearerAuth(expectedToken: string): MiddlewareHandler {
  const expected = sha256(expectedToken);
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
    const presented = match?.[1];
    if (presented === undefined || !timingSafeEqual(sha256(presented), expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
