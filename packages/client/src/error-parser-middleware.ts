import type { Middleware, PreparedRequest } from '@astroid/core';
import { parseErrorBody, type StellarHorizonError } from './errors.js';
import { detectStellarCode } from './middleware/error.js';

/** Enrich thrown client errors with parsed Horizon and API response details. */
export function createErrorParserMiddleware(): Middleware {
  const pendingBodies = new Map<string, unknown>();
  const bodyKey = (req: PreparedRequest): string => `${req.url}:${req.method}`;

  return {
    name: 'astroid-error-parser',
    onResponse(res, req) {
      if (res.status >= 400) {
        pendingBodies.set(bodyKey(req), res.data);
        const detected = detectStellarCode(res.data);
        if (detected) {
          req.options.context = { ...req.options.context, _stellarCode: detected.stellarCode };
        }
      }
    },
    onError(error, req) {
      const body = pendingBodies.get(bodyKey(req));
      pendingBodies.delete(bodyKey(req));
      if (body === undefined) return;
      const parsed = parseErrorBody((error as { status?: number }).status ?? 500, body);
      const target = error as Record<string, unknown>;
      if (parsed.details && !target.details) target.details = parsed.details;
      if (parsed.code) target.code = parsed.code;
      if (parsed.message) target.message = parsed.message;
      const stellar =
        detectStellarCode(body) ??
        (req.options.context?._stellarCode
          ? { stellarCode: req.options.context._stellarCode as string }
          : undefined) ??
        ('stellarCode' in parsed ? (parsed as StellarHorizonError) : undefined);
      if (stellar) target.stellarCode = stellar.stellarCode;
    },
  };
}
