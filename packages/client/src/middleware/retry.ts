import type { Middleware, PreparedRequest, RawResponse } from '@astroid/core';

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function backoffDelay(
  attempt: number,
  configOrBaseMs:
    | number
    | { baseDelayMs?: number; maxDelayMs?: number; maxRetries?: number } = 100,
  maxMsOrRandomFn?: number | (() => number),
): number {
  let baseMs: number;
  let maxMs: number;
  let randomFn: () => number;

  if (typeof configOrBaseMs === 'object' && configOrBaseMs !== null) {
    baseMs = configOrBaseMs.baseDelayMs ?? 100;
    maxMs = configOrBaseMs.maxDelayMs ?? 10000;
    randomFn =
      typeof maxMsOrRandomFn === 'function'
        ? maxMsOrRandomFn
        : Math.random;
  } else {
    baseMs = typeof configOrBaseMs === 'number' ? configOrBaseMs : 100;
    maxMs = typeof maxMsOrRandomFn === 'number' ? maxMsOrRandomFn : 10000;
    randomFn = Math.random;
  }

  const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  return randomFn() * delay;
}

export function createRetryMiddleware(options: { maxRetries?: number; retryDelay?: number } = {}): Middleware {
  const maxRetries = options.maxRetries ?? 3;
  return async (_req: PreparedRequest, next: () => Promise<RawResponse>): Promise<RawResponse> => {
    let attempt = 0;
    while (true) {
      try {
        const res = await next();
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          attempt++;
          await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
          continue;
        }
        return res;
      } catch (err: any) {
        // Don't retry typed errors (with code+status) or known non-retryable errors
        const hasCodeAndStatus = err && typeof err === 'object' && 'code' in err && 'status' in err;
        const isKnownNonRetryable = err?.name === 'AstroidTimeoutError';
        const shouldRetry = !hasCodeAndStatus && !isKnownNonRetryable && attempt < maxRetries;
        if (shouldRetry) {
          attempt++;
          await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
          continue;
        }
        throw err;
      }
    }
  };
}

export const retryMiddleware = createRetryMiddleware;