/**
 * Token-bucket rate limiting middleware for `@astroid/client`.
 *
 * Autonomous agents can fire rapid bursts of SDK requests while executing
 * multi-step operations, which risks tripping API gateway rate limits and
 * causing unhandled failures during critical transactions. This middleware
 * throttles outbound requests to a configurable sustained rate while allowing
 * short bursts, queues excess requests rather than rejecting them instantly
 * (up to a bounded queue length), times out requests that wait too long, and
 * honours `Retry-After` headers returned by the server on 429 responses.
 *
 * It implements a standard token bucket: the bucket holds `burstCapacity`
 * tokens and is refilled at `maxRequestsPerSecond` tokens per second. Each
 * request debits one token; when the bucket is empty the request enters a FIFO
 * queue and waits for the next refill.
 *
 * @module
 */

import { RateLimitError } from '@astroid/errors';
import type { Middleware, PreparedRequest, RawResponse } from '@astroid/core';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link createRateLimiterMiddleware}. */
export interface RateLimitMiddlewareOptions {
  /** Sustained request rate (tokens refilled per second). Default 10. */
  maxRequestsPerSecond?: number;
  /** Token bucket capacity — requests allowed to fire back-to-back. Default 10. */
  burstCapacity?: number;
  /** Max number of requests queued before new ones are rejected. Default 100. */
  maxQueueLength?: number;
  /** Max ms a queued request waits for a token before failing. Default 30_000. */
  queueTimeoutMs?: number;
}

/** A single request blocked until a token becomes available. */
interface Waiter {
  /** Monotonic timestamp when the request began waiting. */
  startedAt: number;
  /** Resolved once a token is granted, with the delay slept before dispatch. */
  resolve: (delayMs: number) => void;
  /** Rejected when the request times out or the signal aborts. */
  reject: (err: unknown) => void;
  /** Per-waiter timeout handle, cleared on grant. */
  timeout: ReturnType<typeof setTimeout> | undefined;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/** Default sustained request rate when not supplied. */
const DEFAULT_REQUESTS_PER_SECOND = 10;
/** Default burst capacity (the token bucket size). */
const DEFAULT_BURST_CAPACITY = 10;
/** Default maximum number of queued requests. */
const DEFAULT_MAX_QUEUE_LENGTH = 100;
/** Default maximum time a request may wait in the queue, in ms. */
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
/** Smallest refill increment used so timing maths never divides by zero. */
const MIN_REFILL_PER_MS = 1e-6;

/* -------------------------------------------------------------------------- */
/* Limiter state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic token bucket. `tokens` reflects the burst allowance, refilled
 * continuously based on elapsed time. Requests that cannot take a token wait
 * on a FIFO queue, drained as tokens refill.
 */
class TokenBucketLimiter {
  readonly capacity: number;
  private tokens: number;
  private readonly refillPerMs: number;
  private readonly maxQueueLength: number;
  private readonly queueTimeoutMs: number;
  private lastRefillAt: number;
  /** When > now, the server asked us to back off (from `Retry-After`). */
  private cooldownUntilAt = 0;
  private readonly waiters: Waiter[] = [];
  private refillScheduled = false;

  constructor(options: RateLimitMiddlewareOptions) {
    this.capacity = positive(options.burstCapacity, DEFAULT_BURST_CAPACITY);
    this.tokens = this.capacity;
    this.refillPerMs =
      Math.max(MIN_REFILL_PER_MS, positive(options.maxRequestsPerSecond, DEFAULT_REQUESTS_PER_SECOND)) / 1000;
    this.maxQueueLength = positive(options.maxQueueLength, DEFAULT_MAX_QUEUE_LENGTH);
    this.queueTimeoutMs = Math.max(0, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    this.lastRefillAt = Date.now();
  }

  /** Refill `tokens` up to capacity using elapsed time since the last refill. */
  private refill(now: number): void {
    const base = Math.max(this.lastRefillAt, this.cooldownUntilAt);
    const elapsed = now - base;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillAt = Math.max(now, this.cooldownUntilAt);
    }
  }

  /**
   * Acquire one token. Resolves with `0` when granted immediately, or with the
   * delay slept when the request had to wait. Rejects with a
   * {@link RateLimitError} when the queue is full, when `queueTimeoutMs`
   * elapses, or when the caller's signal aborts while waiting.
   */
  async acquire(signal?: AbortSignal): Promise<number> {
    const now = Date.now();
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    if (this.waiters.length >= this.maxQueueLength) {
      throw this.queueFullError();
    }
    return new Promise<number>((resolve, reject) => {
      const onAbort = (): void => {
        this.dropWaiter(waiter);
        reject(new DOMException('The rate-limit wait was aborted.', 'AbortError'));
      };
      const waiter: Waiter = {
        startedAt: now,
        resolve: (delayMs) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(delayMs);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        timeout: undefined,
      };
      waiter.timeout =
        this.queueTimeoutMs > 0
          ? setTimeout(() => this.failWaiter(waiter, this.timeoutError(waiter)), this.queueTimeoutMs)
          : undefined;
      if (signal?.aborted) {
        this.failWaiter(waiter, new DOMException('The rate-limit wait was aborted.', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.scheduleRefill();
    });
  }

  /** Remove a waiter (used on abort before it was pushed). */
  private dropWaiter(waiter: Waiter): void {
    this.clearWaiterTimer(waiter);
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  /** Remove + reject a timeout waiter. */
  private failWaiter(waiter: Waiter, err: unknown): void {
    this.clearWaiterTimer(waiter);
    waiter.reject(err);
  }

  private clearWaiterTimer(waiter: Waiter): void {
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
  }

  /** Grant a token to each queued waiter that no longer has to wait. */
  private drain(now: number): void {
    this.refill(now);
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      this.clearWaiterTimer(waiter);
      this.tokens -= 1;
      waiter.resolve(Math.max(0, now - waiter.startedAt));
    }
    if (this.waiters.length > 0) this.scheduleRefill();
  }

  /** Schedule a refill once enough time has passed to mint another token. */
  private scheduleRefill(): void {
    if (this.refillScheduled) return;
    this.refillScheduled = true;
    const now = Date.now();
    const cooldownWait = Math.max(0, this.cooldownUntilAt - now);
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    setTimeout(() => {
      this.refillScheduled = false;
      this.drain(Date.now());
    }, Math.max(1, cooldownWait, tokenWait));
  }

  /** Notify the limiter of a server-side back-off, honouring Retry-After. */
  noteRetryAfter(seconds: number): void {
    if (seconds <= 0) return;
    this.cooldownUntilAt = Date.now() + seconds * 1000;
    this.tokens = 0;
    this.lastRefillAt = this.cooldownUntilAt;
    this.scheduleRefill();
  }

  /** Number of tokens currently available (for observability/headers). */
  get remaining(): number {
    this.refill(Date.now());
    return Math.floor(this.tokens);
  }

  private queueFullError(): RateLimitError {
    return new RateLimitError('Rate-limit queue is full. Retry after the current burst drains.', {
      code: 'RATE_LIMITED',
      details: { retryAfter: estimateRetryAfter(this.waiters.length, this.refillPerMs) },
    });
  }

  private timeoutError(waiter: Waiter): RateLimitError {
    return new RateLimitError(
      `Timed out waiting in the rate-limit queue after ${this.queueTimeoutMs}ms.`,
      {
        code: 'RATE_LIMIT_QUEUE_TIMEOUT',
        details: { retryAfter: Math.max(0, Date.now() - waiter.startedAt) / 1000 },
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A positive finite number, falling back to `fallback` for bad inputs. */
function positive(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  return fallback;
}

/** Seconds until roughly `count` tokens refill at the given per-ms rate. */
function estimateRetryAfter(count: number, refillPerMs: number): number {
  return Math.ceil(count / (refillPerMs * 1000));
}

/** Seconds from a `Retry-After` header, or `undefined` when unparseable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Create a DOM-compatible abort error regardless of runtime. */
function abortError(message: string): Error {
  // eslint-disable-next-line no-restricted-globals
  return typeof DOMException !== 'undefined'
    ? new DOMException(message, 'AbortError')
    : new Error(message);
}

/* -------------------------------------------------------------------------- */
/* Middleware                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a token-bucket rate-limiting middleware.
 *
 * The middleware throttles `onRequest`: when the bucket has a token the request
 * passes through immediately (burst), otherwise it waits in a FIFO queue —
 * rejecting with a {@link RateLimitError} if the queue is full, the caller's
 * signal aborts, or `queueTimeoutMs` elapses. The applied delay is slept
 * before the request is dispatched, so the transport never sees bursts
 * exceeding the configured rate.
 *
 * On 429 responses the middleware reads the `Retry-After` header and feeds it
 * into the bucket, so subsequent requests honour the server's back-off.
 *
 * @param options Rate limiting knobs; all optional with sane defaults.
 * @returns A `Middleware` instance ready for `client.use(...)`.
 *
 * @example
 * ```ts
 * const astroid = new Astroid({ apiKey });
 * astroid.use(createRateLimiterMiddleware({ maxRequestsPerSecond: 25, burstCapacity: 40 }));
 * ```
 */
export function createRateLimiterMiddleware(
  options: RateLimitMiddlewareOptions = {},
): Middleware {
  const limiter = new TokenBucketLimiter(options);

  return {
    name: 'rate-limiter',
    async onRequest(req: PreparedRequest): Promise<PreparedRequest> {
      const signal = (req as any).signal as AbortSignal | undefined;
      const delayMs = await limiter.acquire(signal);
      if (delayMs > 0) await sleep(delayMs, signal);
      if (signal?.aborted) throw abortError('The rate-limit wait was aborted.');
      return {
        ...req,
        headers: {
          ...req.headers,
          'x-ratelimit-limit': String(limiter.capacity),
          'x-ratelimit-remaining': String(limiter.remaining),
        },
      };
    },
    onResponse(res: RawResponse): void {
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (retryAfter !== undefined) limiter.noteRetryAfter(retryAfter);
      }
    },
  };
}

/** Alias of {@link createRateLimiterMiddleware}. */
export const rateLimiterMiddleware = createRateLimiterMiddleware;

/** Sleep for `ms`, aborting early when `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}