/**
 * HTTP response cache wrapper for `@astroid/client`.
 *
 * Wraps an {@link Astroid} (or `AstroidClient`) instance and transparently
 * caches successful GET responses in-memory so that identical requests are
 * served from cache instead of hitting the network. This is especially
 * useful for contract call responses that are fetched repeatedly with the
 * same parameters.
 *
 * Cache behaviour:
 * - Only GET requests are cached; mutations (`POST`, `PUT`, `DELETE`) always
 *   pass through and can optionally invalidate related cache entries.
 * - Responses with HTTP status 200–299 are cached; errors are not.
 * - Cache entries expire after `ttlMs` (default: 60 000 ms / 1 minute).
 * - A configurable `maxSize` caps the number of entries (default: 256).
 *   When the cap is reached, the oldest entry (FIFO) is evicted.
 * - A custom `keyFn` allows callers to control the cache key (e.g. to
 *   exclude volatile query-string parameters).
 * - Cache can be cleared manually via `clear()` or `invalidate(pattern)`.
 *
 * @example
 * ```ts
 * import { Astroid } from '@astroid/client';
 * import { createCachedClient } from '@astroid/client';
 *
 * const client = new Astroid({ apiKey: 'sk_test_...' });
 * const cached = createCachedClient(client, { ttlMs: 30_000 });
 *
 * // First call hits the network
 * const wallet1 = await cached.get('/wallets/w_1');
 * // Second call is served from cache (no network call)
 * const wallet2 = await cached.get('/wallets/w_1');
 *
 * // Invalidate cache for a specific resource
 * cached.invalidate('/wallets/w_1');
 * ```
 *
 * @module
 */

import type { Astroid } from '../index.js';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** Configuration options for the cache wrapper. */
export interface ClientCacheOptions {
  /** Time-to-live in milliseconds. Default: 60 000 (1 minute). */
  ttlMs?: number;
  /** Maximum number of cached entries. Default: 256. */
  maxSize?: number;
  /** Custom key function. Defaults to `${method}:${path}`. */
  keyFn?: (method: string, path: string) => string;
  /** Optional callback fired when a cache hit occurs. */
  onHit?: (key: string) => void;
  /** Optional callback fired when a cache miss occurs. */
  onMiss?: (key: string) => void;
  /** Whether to invalidate cache entries for related resources on mutations. Default: true. */
  invalidateOnMutation?: boolean;
}

/** A cached HTTP response. */
interface CacheEntry {
  /** Response body. */
  body: unknown;
  /** Response status code. */
  status: number;
  /** Timestamp when the entry was created (ms). */
  createdAt: number;
}

/** A snapshot of cache statistics. */
export interface CacheStats {
  /** Number of entries currently in the cache. */
  size: number;
  /** All cache keys. */
  keys: string[];
  /** Max capacity. */
  maxSize: number;
  /** Current TTL setting. */
  ttlMs: number;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/** Default TTL in milliseconds (1 minute). */
const DEFAULT_TTL_MS = 60_000;
/** Default maximum number of cached entries. */
const DEFAULT_MAX_SIZE = 256;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Default cache key: `METHOD:path`. */
function defaultKeyFn(method: string, path: string): string {
  return `${method}:${path}`;
}

/** Extract the resource base path from a full path for invalidation. */
function resourceBase(path: string): string {
  // /wallets/w_1  → /wallets
  // /agents/a_1/status → /agents
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) {
    return `/${segments[0]}`;
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* Cached client wrapper                                                       */
/* -------------------------------------------------------------------------- */

export interface CachedClient {
  /** Underlying Astroid client. */
  readonly client: Astroid;

  /** Perform a GET request (cached). */
  get<T = unknown>(path: string, options?: { headers?: Record<string, string> }): Promise<T>;
  /** Perform a POST request (always hits network). */
  post<T = unknown>(path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
  /** Perform a PUT request (always hits network). */
  put<T = unknown>(path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
  /** Perform a DELETE request (always hits network). */
  delete<T = unknown>(path: string, options?: { headers?: Record<string, string> }): Promise<T>;

  /** Clear all cached entries. */
  clear(): void;
  /** Remove cache entries matching a pattern (substring or regex). */
  invalidate(pattern: string | RegExp): void;
  /** Number of cached entries. */
  size(): number;
  /** Return a snapshot of cache statistics. */
  stats(): CacheStats;
}

/**
 * Create a cache wrapper around an {@link Astroid} client instance.
 *
 * The wrapper exposes the same `get`, `post`, `put`, `delete` methods but
 * transparently caches successful GET responses. Mutations always go through
 * to the network and can optionally invalidate related cache entries.
 *
 * @param client  The underlying Astroid client to wrap.
 * @param options Cache configuration.
 * @returns A {@link CachedClient} with caching behaviour.
 */
export function createCachedClient(
  client: Astroid,
  options: ClientCacheOptions = {},
): CachedClient {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const keyFn = options.keyFn ?? defaultKeyFn;
  const onHit = options.onHit;
  const onMiss = options.onMiss;
  const invalidateOnMutation = options.invalidateOnMutation ?? true;

  /** The cache: key → entry. */
  const cache = new Map<string, CacheEntry>();

  /** FIFO eviction queue: tracks keys in order of insertion. */
  const evictionQueue: string[] = [];
  /** Keys that were evicted from the queue (re-inserts don't rejoin). */
  const evictedKeys = new Set<string>();

  /* ------------------------------------------------------------------ */
  /* Internal helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** Get a cached entry if it exists and hasn't expired. */
  function getEntry(key: string): CacheEntry | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt >= ttlMs) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  /** Store an entry in the cache. */
  function setEntry(key: string, entry: CacheEntry): void {
    cache.set(key, entry);

    if (evictedKeys.has(key)) {
      // Re-inserted entry: don't rejoin the eviction queue.
      // This gives the entry a "second chance" without disrupting
      // the eviction order of other entries.
      evictedKeys.delete(key);
    } else {
      evictionQueue.push(key);
    }

    // Evict from the front of the queue while over capacity.
    while (evictionQueue.length > maxSize) {
      const oldest = evictionQueue.shift()!;
      if (cache.has(oldest)) {
        cache.delete(oldest);
        evictedKeys.add(oldest);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                           */
  /* ------------------------------------------------------------------ */

  function clear(): void {
    cache.clear();
    evictionQueue.length = 0;
    evictedKeys.clear();
  }

  function invalidate(pattern: string | RegExp): void {
    const matcher =
      typeof pattern === 'string'
        ? (key: string) => key.includes(pattern)
        : (key: string) => pattern.test(key);
    for (const key of Array.from(cache.keys())) {
      if (matcher(key)) {
        cache.delete(key);
        const idx = evictionQueue.indexOf(key);
        if (idx !== -1) evictionQueue.splice(idx, 1);
      }
    }
  }

  function size(): number {
    return cache.size;
  }

  function stats(): CacheStats {
    return { size: cache.size, keys: Array.from(cache.keys()), maxSize, ttlMs };
  }

  /* ------------------------------------------------------------------ */
  /* Cached GET                                                           */
  /* ------------------------------------------------------------------ */

  async function get<T = unknown>(
    path: string,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const key = keyFn('GET', path);

    // Check cache
    const entry = getEntry(key);
    if (entry) {
      onHit?.(key);
      return entry.body as T;
    }

    // Cache miss — fetch from network
    onMiss?.(key);
    const response = await client.get<{ data: T }>(path, {
      headers: options?.headers,
    } as any);

    // Cache successful response
    const body = (response as any).data !== undefined ? (response as any).data : response;
    setEntry(key, {
      body,
      status: 200,
      createdAt: Date.now(),
    });

    return body as T;
  }

  /* ------------------------------------------------------------------ */
  /* Mutations (always network + optional invalidation)                    */
  /* ------------------------------------------------------------------ */

  async function post<T = unknown>(
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const result = await client.post<T>(path, body, options as any);
    if (invalidateOnMutation) {
      // Invalidate cache entries for the resource and its parent collection
      invalidate(resourceBase(path));
    }
    return result;
  }

  async function put<T = unknown>(
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const result = await client.put<T>(path, body, options as any);
    if (invalidateOnMutation) {
      invalidate(resourceBase(path));
    }
    return result;
  }

  async function delete_<T = unknown>(
    path: string,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    const result = await client.delete<T>(path, options as any);
    if (invalidateOnMutation) {
      invalidate(resourceBase(path));
    }
    return result;
  }

  return {
    client,
    get,
    post,
    put,
    delete: delete_,
    clear,
    invalidate,
    size,
    stats,
  };
}
