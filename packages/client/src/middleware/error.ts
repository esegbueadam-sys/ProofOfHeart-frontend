/**
 * `@astroid/client` — structured error translation middleware.
 *
 * Intercepts HTTP error responses from the Astroid API and the Stellar Horizon
 * network, mapping them to high-fidelity, typed domain exceptions so consumer
 * application loops can branch on `instanceof` instead of parsing raw strings.
 *
 * ## How it works
 *
 * 1. **HTTP status is inspected first** (e.g. `402`, `403`, `409`) as a fast
 *    path, but the decisive mapping comes from the response body.
 * 2. **Horizon result codes** — the Horizon server reports failures in
 *    `extras.result_codes` (`transaction` / `operations`). Codes such as
 *    `op_underfunded` and `op_low_reserve` are translated to
 *    {@link InsufficientFundsError} (also exported as
 *    `AstroidInsufficientFundsError` for docs parity). Other horizon codes are
 *    mapped to the closest domain error (`NotFoundError`, `ConflictError`, …).
 * 3. **Astroid API error envelope** — when the body contains
 *    `{ error: { code, message, details } }`, the `code` (e.g.
 *    `POLICY_VIOLATION`, `BUDGET_EXCEEDED`, `INSUFFICIENT_FUNDS`) is mapped via
 *    `@astroid/errors` to its typed class (`PolicyViolationError`,
 *    `BudgetExceededError`, `InsufficientFundsError`). The original
 *    `details` and `requestId` are preserved.
 * 4. **Pass-through** — any error shape that does not match a known pattern
 *    is left untouched; the underlying `HttpClient` then produces a status-based
 *    fallback (`ValidationError`, `ServerError`, …) with full details intact.
 *
 * The middleware is installed by default in {@link Astroid} so no manual setup
 * is required. It is also exported as a standalone factory for advanced use:
 * `new Astroid(cfg).use(createErrorTranslatorMiddleware())`.
 *
 * ## Error classes
 *
 * All translated errors extend {@link AstroidError} from `@astroid/errors`:
 * - `AstroidPolicyViolationError` / `PolicyViolationError` — spending policy rejection
 * - `AstroidInsufficientFundsError` / `InsufficientFundsError` — Horizon `op_underfunded`/`op_low_reserve` and API `INSUFFICIENT_FUNDS`
 * - `BudgetExceededError`, `ApprovalRequiredError`, `NotFoundError`, `ConflictError`, …
 * - `StellarHorizonError` — generic Horizon failure when no domain mapping applies (preserved)
 *
 * @module
 */

import {
  AstroidError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  PolicyViolationError,
  InsufficientFundsError,
  BudgetExceededError,
  ApprovalRequiredError,
  RateLimitError,
  ServerError,
  errorClassForCode,
} from '@astroid/errors';
import { isRetryableStatus } from '@astroid/core';
import type { Middleware, RawResponse, PreparedRequest } from '@astroid/core';

import { StellarHorizonError } from '../errors.js';

// Re-export domain errors for convenience (docs use `Astroid*` prefix).
export {
  AstroidError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  PolicyViolationError,
  InsufficientFundsError,
  BudgetExceededError,
  ApprovalRequiredError,
  RateLimitError,
  ServerError,
  StellarHorizonError,
};

export const AstroidPolicyViolationError = PolicyViolationError;
export const AstroidInsufficientFundsError = InsufficientFundsError;
export const AstroidBudgetExceededError = BudgetExceededError;
export const AstroidApprovalRequiredError = ApprovalRequiredError;

// ---------------------------------------------------------------------------
// Horizon code → domain error mapping
// ---------------------------------------------------------------------------

/**
 * Map known Horizon result codes to the most specific SDK domain error.
 * Codes not listed here produce a generic {@link StellarHorizonError} via the
 * fallback error parser and are not remapped by this middleware.
 */
const HORIZON_DOMAIN_MAP: Record<string, typeof AstroidError> = {
  // Funds / reserve — treated as insufficient funds for application logic
  op_underfunded: InsufficientFundsError,
  op_low_reserve: InsufficientFundsError,
  tx_insufficient_balance: InsufficientFundsError,
  tx_insufficient_fee: InsufficientFundsError,
  // Trust / destination
  op_no_destination: NotFoundError,
  op_no_trust: ValidationError,
  op_line_full: ValidationError,
  // Auth
  op_bad_auth: AuthenticationError,
  op_unauthorized: AuthorizationError,
  tx_bad_auth: AuthenticationError,
  // Sequence / conflict
  tx_bad_seq: ConflictError,
  tx_too_late: ValidationError,
};

const HORIZON_STATUS_MAP: Record<string, number> = {
  op_underfunded: 402,
  op_low_reserve: 402,
  tx_insufficient_balance: 402,
  op_no_destination: 404,
  op_no_trust: 422,
  op_unauthorized: 403,
  op_bad_auth: 401,
  tx_bad_seq: 409,
  tx_bad_auth: 401,
  tx_too_late: 410,
  tx_insufficient_fee: 402,
};

// ---------------------------------------------------------------------------
// Payload inspection helpers
// ---------------------------------------------------------------------------

function extractMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const errorField = obj.error;
  if (typeof errorField === 'object' && errorField !== null) {
    const msg = (errorField as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  if (typeof obj.detail === 'string') return obj.detail;
  // Horizon may carry title/detail
  if (typeof obj.title === 'string') return obj.title;
  return undefined;
}

function extractDetails(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const errorField = obj.error;
  if (typeof errorField === 'object' && errorField !== null) {
    const details = (errorField as Record<string, unknown>).details;
    if (typeof details === 'object' && details !== null) return details as Record<string, unknown>;
  }
  if (typeof obj.extras === 'object' && obj.extras !== null)
    return obj.extras as Record<string, unknown>;
  if (typeof obj.details === 'object' && obj.details !== null)
    return obj.details as Record<string, unknown>;
  return undefined;
}

function extractApiError(
  body: unknown,
): { code: string; message: string; details?: Record<string, unknown> } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const errorField = obj.error;
  if (typeof errorField !== 'object' || errorField === null) return undefined;
  const err = errorField as Record<string, unknown>;
  if (typeof err.code !== 'string' || typeof err.message !== 'string') return undefined;
  return {
    code: err.code,
    message: err.message,
    details:
      typeof err.details === 'object' && err.details !== null
        ? (err.details as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Detect Stellar Horizon result codes from various payload shapes.
 */
export function detectStellarCode(
  body: unknown,
): { stellarCode: string; operationCode?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const extras = obj.extras as Record<string, unknown> | undefined;
  if (extras) {
    const resultCodes = extras.result_codes as Record<string, unknown> | undefined;
    if (resultCodes) {
      const transactionCode =
        typeof resultCodes.transaction === 'string' ? resultCodes.transaction : undefined;
      const operationCodes = resultCodes.operations as string[] | undefined;
      const opCode = operationCodes?.[0];
      const code = opCode ?? transactionCode;
      if (code) return { stellarCode: code, operationCode: opCode };
    }
  }
  const resultCode = typeof obj.result_code === 'string' ? obj.result_code : undefined;
  const stellarCode = typeof obj.stellarCode === 'string' ? obj.stellarCode : undefined;
  const code = resultCode ?? stellarCode;
  if (code) return { stellarCode: code };
  return undefined;
}

// ---------------------------------------------------------------------------
// Core translation
// ---------------------------------------------------------------------------

/**
 * Attempt to translate an error response body + status into a high-fidelity
 * domain error. Returns `undefined` when no mapping applies so the caller can
 * fall back to the default status-based error (preserving original details).
 *
 * This function is pure and synchronous, suitable for both `onResponse` and
 * `onError` middleware hooks as well as direct unit testing.
 */
export function translateErrorBody(
  status: number,
  body: unknown,
  requestId?: string,
): AstroidError | undefined {
  // 1. Stellar Horizon result codes — highest fidelity for transaction failures
  const stellar = detectStellarCode(body);
  if (stellar) {
    const DomainError = HORIZON_DOMAIN_MAP[stellar.stellarCode];
    if (DomainError) {
      const message = extractMessage(body) ?? `Stellar transaction failed: ${stellar.stellarCode}`;
      const details = extractDetails(body);
      const statusForCode = HORIZON_STATUS_MAP[stellar.stellarCode] ?? status;
      return new DomainError(message, {
        code: stellar.stellarCode,
        status: statusForCode,
        requestId,
        details: details
          ? { ...details, stellarCode: stellar.stellarCode, operationCode: stellar.operationCode }
          : { stellarCode: stellar.stellarCode, operationCode: stellar.operationCode },
      });
    }
    // No domain mapping — let the generic StellarHorizonError path handle it (via HttpClient)
    return undefined;
  }

  // 2. Standard API error envelope: { error: { code, message, details } }
  const apiError = extractApiError(body);
  if (apiError) {
    const DomainError = errorClassForCode(apiError.code);
    if (DomainError !== AstroidError) {
      return new DomainError(apiError.message, {
        code: apiError.code,
        status,
        requestId,
        details: apiError.details ?? extractDetails(body),
      });
    }
    // Also handle codes that are not in ApiErrorCode but are horizon codes leaked as API codes
    if (apiError.code === 'op_low_reserve' || apiError.code === 'op_underfunded') {
      const msg = apiError.message;
      return new InsufficientFundsError(msg, {
        code: apiError.code,
        status: status === 200 ? 402 : status,
        requestId,
        details: apiError.details,
      });
    }
  }

  // 3. Status-based fallback for well-known cases where body is minimal
  // Only synthesize when the status strongly signals the domain and body lacks a more specific code.
  if (status === 402) {
    const msg = extractMessage(body) ?? 'Insufficient funds';
    // Avoid overriding a generic 402 that already has a specific body envelope — handled above.
    // Here body didn't contain a mappable apiError or stellar code, so status is the best signal.
    if (!apiError) {
      return new InsufficientFundsError(msg, {
        code: 'INSUFFICIENT_FUNDS',
        status,
        requestId,
        details: extractDetails(body),
      });
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the error translator middleware. Installs an `onResponse` interceptor
 * that throws domain-specific errors for known Horizon / API patterns before
 * the `HttpClient`'s default error builder runs, and an `onError` interceptor
 * that refines generic `StellarHorizonError`s that may have been produced by
 * other layers.
 *
 * The middleware deliberately **does not** intercept `401` (which is handled by
 * the session refresh / dynamic token provider) nor retryable statuses
 * (`408`, `429`, `5xx`) so that the `HttpClient`'s built-in retry and refresh
 * loops retain full control. Those cases are instead refined in `onError`
 * after retries are exhausted.
 *
 * The middleware is idempotent and safe to register multiple times.
 */
export function createErrorTranslatorMiddleware(): Middleware {
  return {
    name: 'error-translator',
    async onResponse(res: RawResponse, _req: PreparedRequest) {
      if (res.status < 400) return;
      // Let the client's 401 refresh handler and retry loop run first
      if (res.status === 401) return;
      if (isRetryableStatus(res.status)) return;
      const translated = translateErrorBody(res.status, res.data ?? (res as any).body, res.requestId);
      if (translated) throw translated;
      // No translation — pass through to HttpClient's default handling
    },
    async onError(error: unknown, _req: PreparedRequest) {
      // Remap generic StellarHorizonError to domain errors
      if (error instanceof StellarHorizonError) {
        const DomainError = HORIZON_DOMAIN_MAP[error.stellarCode];
        if (DomainError) {
          throw new DomainError(error.message, {
            code: error.stellarCode,
            status: error.status,
            requestId: error.requestId,
            details: error.details,
            cause: (error as unknown as { cause?: unknown }).cause,
          });
        }
      }
      // Refine generic AstroidError with a mappable code (e.g., a fallback AstroidError for INSUFFICIENT_FUNDS)
      if (error instanceof AstroidError) {
        const ae = error as AstroidError;
        const DomainError = errorClassForCode(ae.code);
        if (DomainError !== AstroidError && !(error instanceof DomainError)) {
          throw new DomainError(ae.message, {
            code: ae.code,
            status: ae.status,
            requestId: ae.requestId,
            details: ae.details,
            cause: (error as unknown as { cause?: unknown }).cause,
          });
        }
      }
    },
  };
}

/**
 * Singleton middleware instance for convenience (equivalent to
 * `createErrorTranslatorMiddleware()`).
 */
export const errorTranslatorMiddleware = createErrorTranslatorMiddleware();

/** Alias for backwards compatibility with docs that refer to `errorMiddleware`. */
export const errorMiddleware = errorTranslatorMiddleware;

export default createErrorTranslatorMiddleware;
