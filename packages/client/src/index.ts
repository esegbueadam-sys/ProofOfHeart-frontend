/**
 * `@astroid/client` — main SDK entry point.
 *
 * Provides the `Astroid` class with resource namespaces, an event system,
 * a plugin system, middleware pipeline, session management, automatic token
 * injection / refresh, and re-exports from sub-modules.
 *
 * @module
 */

/* -------------------------------------------------------------------------- */
/* Imports                                                                     */
/* -------------------------------------------------------------------------- */

import { HttpClient } from '@astroid/core';
import type {
  Middleware,
  PreparedRequest,
  RawResponse,
} from '@astroid/core';
import { buildQueryString } from '@astroid/core';

// Locally-defined types that aren't re-exported from @astroid/core
type MiddlewareFunction = (
  req: PreparedRequest,
  next: () => Promise<RawResponse>
) => Promise<RawResponse>;

type MiddlewareObject = {
  name?: string;
  onRequest?: (req: PreparedRequest) => any;
  onResponse?: (res: RawResponse, req: PreparedRequest) => any;
  onError?: (error: any, req: PreparedRequest) => any;
  [key: string]: any;
};

import { serializeQuery, type QueryParams } from './query.js';
import {
  createCorrelationMiddleware,
} from './middleware/correlation.js';
import {
  createErrorTranslatorMiddleware,
  translateErrorBody,
  AstroidError,
  AuthenticationError,
} from './middleware/error.js';
import {
  createRateLimiterMiddleware,
  type RateLimitMiddlewareOptions,
} from './middleware/rate-limiter.js';
import {
  createRetryMiddleware,
} from './middleware/retry.js';
import { createErrorParserMiddleware } from './error-parser-middleware.js';
import {
  createCachedClient,
} from './middleware/cache.js';



/* -------------------------------------------------------------------------- */
/* Re-exports                                                                  */
/* -------------------------------------------------------------------------- */

export * from './error-parser-middleware.js';
export * from './errors.js';
export * from './middleware/cache.js';
export * from './middleware/correlation.js';
export {
  createErrorTranslatorMiddleware,
  translateErrorBody,
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
  AstroidPolicyViolationError,
  AstroidInsufficientFundsError,
} from './middleware/error.js';
export {
  createRateLimiterMiddleware,
  rateLimiterMiddleware,
  type RateLimitMiddlewareOptions,
} from './middleware/rate-limiter.js';
export {
  createRetryMiddleware,
  retryMiddleware,
  backoffDelay,
  isRetryableStatus,
} from './middleware/retry.js';
export { serializePaginationParams, unwrapPaginatedResponse } from './pagination.js';
export { createCachedClient };
export { serializeQuery };
export type { QueryParams };

/* -------------------------------------------------------------------------- */
/* Config types                                                                */
/* -------------------------------------------------------------------------- */

export interface AstroidClientConfig {
  /** A secret API key. */
  apiKey?: string;
  /** A short-lived access token, or an async function that returns one. */
  accessToken?: string | (() => Promise<string>);
  /** A refresh token used to obtain a new access token pair. */
  refreshToken?: string;
  /** Callback invoked whenever tokens are refreshed or updated. */
  onTokenUpdate?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  }) => void | Promise<void>;
  /** API base URL. */
  baseUrl?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Global request timeout in ms. */
  timeoutMs?: number;
  /** Injected fetch implementation. */
  fetch?: typeof fetch;
  /** Retry configuration, or `false` to disable. */
  retry?:
    | { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number }
    | boolean;
  /** Maximum number of retries (shorthand). */
  retries?: number;
  /** Base retry delay in ms (shorthand). */
  retryDelay?: number;
  /** Rate-limiting options, or `false` to disable. */
  rateLimit?: RateLimitMiddlewareOptions | false;
  /** Request/response telemetry hooks. */
  telemetry?: any;
}

/* -------------------------------------------------------------------------- */
/* EventEmitter                                                                */
/* -------------------------------------------------------------------------- */

/** Minimal typed event emitter. */
class EventEmitter {
  private _listeners: Record<string, Function[]> = {};

  on(event: string, fn: Function): () => void {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => this.off(event, fn);
  }

  once(event: string, fn: Function): () => void {
    const g = (...args: any[]) => {
      this.off(event, g);
      fn(...args);
    };
    return this.on(event, g);
  }

  off(event: string, fn: Function): void {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((l) => l !== fn);
  }

  emit(eventOrEnvelope: string | { event?: string; data?: any; [key: string]: any }, data?: any): void {
    const eventName = typeof eventOrEnvelope === 'string'
      ? eventOrEnvelope
      : eventOrEnvelope.event;
    if (!eventName) return;
    const payload = typeof eventOrEnvelope === 'string' ? data : eventOrEnvelope.data;
    if (!this._listeners[eventName]) return;
    [...this._listeners[eventName]].forEach((fn) => fn(payload));
  }

  removeAllListeners(event?: string): void {
    if (event) {
      delete this._listeners[event];
    } else {
      this._listeners = {};
    }
  }
}

/* -------------------------------------------------------------------------- */
/* SessionManager                                                              */
/* -------------------------------------------------------------------------- */

/** Manages access/refresh token pair. */
export class SessionManager {
  private _accessToken?: string;
  private _refreshToken?: string;

  getAccessToken(): string | undefined {
    return this._accessToken;
  }

  getRefreshToken(): string | undefined {
    return this._refreshToken;
  }

  setAccessToken(token: string | undefined): void {
    this._accessToken = token;
  }

  setRefreshToken(token: string | undefined): void {
    this._refreshToken = token;
  }

  updateTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
  }): void {
    this._accessToken = tokens.accessToken;
    if (tokens.refreshToken !== undefined) {
      this._refreshToken = tokens.refreshToken;
    }
  }

  clear(): void {
    this._accessToken = undefined;
    this._refreshToken = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Resource namespace                                                          */
/* -------------------------------------------------------------------------- */

/** A simple resource namespace with `get` and `list` methods. */
export interface ResourceNamespace {
  get(id: string, options?: RequestOptions): Promise<any>;
  list(options?: RequestOptions): Promise<any>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  headers?: Record<string, string>;
  query?: QueryParams;
  correlationId?: string;
  timeoutMs?: number;
  retryable?: boolean;
  signal?: AbortSignal;
  context?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Middleware chain                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Execute the middleware chain for a single request.
 *
 * Handles both `MiddlewareFunction` (wrapping style) and `MiddlewareObject`
 * (hook style) middleware. The execution order is:
 *   1. `onRequest` hooks from `MiddlewareObject` middleware
 *   2. `MiddlewareFunction` middleware wraps the fetch + `onResponse`
 *   3. Actual fetch call
 *   4. `onResponse` hooks from `MiddlewareObject` middleware
 *   5. On error: `onError` hooks from `MiddlewareObject` middleware
 */
async function executeMiddlewareChain(
  middlewares: Middleware[],
  req: PreparedRequest,
  fetchFn: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  // Separate middleware by type
  const objectMws: MiddlewareObject[] = [];
  const functionMws: MiddlewareFunction[] = [];

  for (const mw of middlewares) {
    if (typeof mw === 'function') {
      functionMws.push(mw as MiddlewareFunction);
    } else {
      objectMws.push(mw as MiddlewareObject);
    }
  }

  // 1. Run onRequest hooks from MiddlewareObject middleware
  let currentReq: PreparedRequest = { ...req };
  for (const mw of objectMws) {
    if (mw.onRequest) {
      const result = await mw.onRequest(currentReq);
      if (result) currentReq = result;
    }
  }

  // 2. Build the core handler (fetch + onResponse hooks)
  const coreHandler = async (): Promise<RawResponse> => {
    const res = await fetchFn();
    const responseData = res.data ?? res.body;
    const rawRes = {
      status: res.status,
      headers: res.headers,
      data: responseData,
      body: responseData,
      requestId: res.requestId,
    } as RawResponse & { body: unknown };

    // Run onResponse hooks
    for (const mw of objectMws) {
      if (mw.onResponse) {
        await mw.onResponse(rawRes, currentReq);
      }
    }

    // Default error handling: if no middleware threw for a non-2xx response,
    // translate the error body into a typed exception.
    // Skip 401 — handled by the request() method for token refresh.
    if (rawRes.status >= 400 && rawRes.status !== 401) {
      const body = rawRes.body ?? rawRes.data;
      const translated = translateErrorBody(rawRes.status, body, rawRes.requestId);
      if (translated) throw translated;
      // Generic fallback
      const msg = body?.error?.message ?? body?.message ?? `Request failed with status ${rawRes.status}`;
      const code = body?.error?.code ?? 'BAD_REQUEST';
      throw new AstroidError(msg, { code, status: rawRes.status, requestId: rawRes.requestId });
    }

    return rawRes;
  };

  // 3. Wrap with MiddlewareFunction middleware (inside-out)
  let handler = coreHandler;
  for (let i = functionMws.length - 1; i >= 0; i--) {
    const fn = functionMws[i]!;
    const prevHandler = handler;
    handler = () => fn(currentReq, prevHandler);
  }

  // 4. Execute
  let rawRes: RawResponse;
  try {
    rawRes = await handler();
  } catch (error) {
    // Run onError hooks
    for (const mw of objectMws) {
      if (mw.onError) {
        try {
          await mw.onError(error, currentReq);
        } catch (newError) {
          throw newError;
        }
      }
    }
    throw error;
  }

  // Convert RawResponse to HttpResponse
  return {
    status: rawRes.status,
    headers: rawRes.headers,
    body: rawRes.data,
    data: rawRes.data,
    requestId: rawRes.requestId,
  } as HttpResponse;
}

/* -------------------------------------------------------------------------- */
/* Internal HttpResponse type                                                  */
/* -------------------------------------------------------------------------- */

interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  data: T;
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/* ClientHttpClient — wraps core HttpClient with middleware                    */
/* -------------------------------------------------------------------------- */

export class ClientHttpClient {
  /** Registered middleware. */
  middleware: Middleware[] = [];

  private _inner: HttpClient;
  private _baseUrl: string;
  private _sessionManager: SessionManager;
  private _staticToken?: string;
  private _tokenProvider?: () => string | Promise<string>;
  private _onTokenUpdate?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  }) => void | Promise<void>;
  private _refreshToken?: string;
  private _refreshPromise: Promise<any> | null = null;

  constructor(config: AstroidClientConfig) {
    this._baseUrl = config.baseUrl ?? '';
    this._sessionManager = new SessionManager();

    this._inner = new HttpClient({
      baseUrl: this._baseUrl,
      headers: config.headers,
      timeout: (config as any).timeout,
      timeoutMs: config.timeoutMs,
      fetch: config.fetch,
    });

    // Set initial tokens
    if (typeof config.accessToken === 'string') {
      this._staticToken = config.accessToken;
      this._sessionManager.setAccessToken(config.accessToken);
    } else if (typeof config.accessToken === 'function') {
      this._tokenProvider = config.accessToken;
    }
    if (config.refreshToken) {
      this._refreshToken = config.refreshToken;
      this._sessionManager.setRefreshToken(config.refreshToken);
    }
    this._onTokenUpdate = config.onTokenUpdate;
  }

  /** The underlying session manager. */
  get sessionManager(): SessionManager {
    return this._sessionManager;
  }

  /** Set a static access token. */
  setAccessToken(token: string): void {
    this._staticToken = token;
    this._sessionManager.setAccessToken(token);
  }

  /** Set a dynamic token provider function. */
  setTokenProvider(provider: () => string | Promise<string>): void {
    this._tokenProvider = provider;
  }

  /** Register middleware. */
  use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  /** Cache for in-flight token provider calls (deduplication). */
  private _tokenPromise: Promise<string | undefined> | null = null;

  /** Resolve the current access token. Deduplicates concurrent calls. */
  private async _resolveToken(): Promise<string | undefined> {
    if (this._tokenProvider) {
      if (!this._tokenPromise) {
        this._tokenPromise = Promise.resolve(this._tokenProvider()).finally(() => {
          this._tokenPromise = null;
        });
      }
      return this._tokenPromise;
    }
    if (this._staticToken) {
      return this._staticToken;
    }
    return undefined;
  }

  /** Attempt to refresh the access token. Returns new tokens or undefined. */
  private async _refreshAccessToken(): Promise<
    | {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        tokenType: 'Bearer';
      }
    | undefined
  > {
    if (!this._refreshToken) return undefined;

    try {
      const response = await this._inner.request({
        method: 'POST',
        path: '/auth/refresh',
        body: { refreshToken: this._refreshToken },
      });

      const respBody = (response as any).data ?? (response as any).body;
      if (response.status >= 200 && response.status < 300 && respBody?.accessToken) {
        const newTokens = {
          accessToken: respBody.accessToken as string,
          refreshToken: (respBody.refreshToken as string) || this._refreshToken,
          expiresIn: (respBody.expiresIn as number) || 3600,
          tokenType: 'Bearer' as const,
        };

        this._staticToken = newTokens.accessToken;
        this._refreshToken = newTokens.refreshToken;
        this._sessionManager.updateTokens(newTokens);

        if (this._onTokenUpdate) {
          await this._onTokenUpdate(newTokens);
        }

        return newTokens;
      }
    } catch {
      // Network error during refresh
    }

    // Refresh failed — clear tokens
    this._staticToken = undefined;
    this._refreshToken = undefined;
    this._sessionManager.clear();

    return undefined;
  }

  /** Core request implementation with middleware chain and 401 refresh. */
  async request<T = unknown>(options: any): Promise<HttpResponse<T>> {
    const retryCount = options._retryCount ?? 0;

    // Resolve and inject the Authorization header
    const token = await this._resolveToken();
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    // Build PreparedRequest
    const path = options.path ?? '';
    const rawUrl = this._baseUrl
      ? `${this._baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
      : path;
    const queryStr = options.query
      ? buildQueryString(options.query)
      : '';
    const url = queryStr ? `${rawUrl}${queryStr}` : rawUrl;

    const preparedReq: PreparedRequest = {
      url,
      method: options.method ?? 'GET',
      headers,
      init: {},
      options: {
        method: options.method ?? 'GET',
        path,
        correlationId: options.correlationId,
        context: options.context ?? {},
      },
      body: options.body,
    };

    // Execute the middleware chain
    const res = await executeMiddlewareChain(
      this.middleware,
      preparedReq,
      () =>
        this._inner.request<T>({
          method: options.method ?? 'GET',
          path,
          headers,
          body: options.body,
          query: options.query,
          signal: options.signal,
          timeout: options.timeoutMs,
        } as any),
    );

    // Handle 401 auto-refresh / token re-evaluation (only once per request chain)
    if (res.status === 401) {
      // Check if this is an auth endpoint (no retry on /auth/*)
      const isAuthEndpoint = options.path && options.path.startsWith('/auth/');

      if (!isAuthEndpoint && retryCount === 0) {
        if (this._refreshToken) {
          // Try refresh token flow
          if (!this._refreshPromise) {
            this._refreshPromise = this._refreshAccessToken().finally(() => {
              this._refreshPromise = null;
            });
          }
          const newTokens = await this._refreshPromise;
          if (newTokens) {
            return this.request<T>({ ...options, _retryCount: 1 });
          }
        } else if (this._tokenProvider) {
          // Dynamic token provider: clear cached promise and retry once
          this._tokenPromise = null;
          return this.request<T>({ ...options, _retryCount: 1 });
        }
      }

      // No refresh token / auth endpoint / already retried — throw
      const errorBody: any = res.data ?? res.body;
      const message = errorBody?.error?.message ?? 'Authentication failed';
      const code = errorBody?.error?.code ?? 'UNAUTHORIZED';
      throw new AuthenticationError(message, {
        code,
        status: 401,
      });
    }

    return res as HttpResponse<T>;
  }

  /** Perform a GET request. */
  async get<T = unknown>(
    path: string,
    options?: any,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'GET', path });
  }

  /** Perform a POST request. */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: any,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'POST', path, body });
  }

  /** Perform a PUT request. */
  async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: any,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'PUT', path, body });
  }

  /** Perform a DELETE request. */
  async delete<T = unknown>(
    path: string,
    options?: any,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'DELETE', path });
  }
}

/* -------------------------------------------------------------------------- */
/* Resource namespace builder                                                  */
/* -------------------------------------------------------------------------- */

/** Unwrap { data: ... } envelope from a parsed response body. */
function unwrapEnvelope<T>(data: any): T {
  if (data && typeof data === 'object' && 'data' in data && Object.keys(data).length === 1) {
    return data.data as T;
  }
  return data as T;
}

function createResourceNamespace(
  http: ClientHttpClient,
  basePath: string,
): ResourceNamespace {
  return {
    async get(id: string, options?: RequestOptions): Promise<any> {
      const qs = options?.query ? serializeQuery(options.query) : '';
      const fullPath = `${basePath}/${id}${qs}`;
      const res = await http.get(fullPath, {
        headers: options?.headers,
        correlationId: options?.correlationId,
        signal: options?.signal,
      });
      return unwrapEnvelope(res.data);
    },
    async list(options?: RequestOptions): Promise<any> {
      const qs = options?.query ? serializeQuery(options.query) : '';
      const fullPath = `${basePath}${qs}`;
      const res = await http.get(fullPath, {
        headers: options?.headers,
        correlationId: options?.correlationId,
        signal: options?.signal,
      });
      return unwrapEnvelope(res.data);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Astroid                                                                     */
/* -------------------------------------------------------------------------- */

/** Resource namespace that also exposes `create`, `update`, etc. */
export interface ResourceNamespace {
  get(id: string, options?: RequestOptions): Promise<any>;
  list(options?: RequestOptions): Promise<any>;
  [key: string]: any;
}

/**
 * Astroid SDK client.
 *
 * Provides resource namespaces, middleware pipeline, event system,
 * plugin system, and session management.
 */
export class Astroid extends EventEmitter {
  /** The underlying HTTP client with middleware support. */
  readonly http: ClientHttpClient;
  /** Session manager for tracking access/refresh tokens. */
  readonly sessionManager: SessionManager;

  /* Resource namespaces */
  readonly wallets: ResourceNamespace;
  readonly agents: ResourceNamespace;
  readonly policies: ResourceNamespace;
  readonly budgets: ResourceNamespace;
  readonly transactions: ResourceNamespace;
  readonly notifications: ResourceNamespace;
  readonly analytics: ResourceNamespace;
  readonly webhooks: ResourceNamespace;
  readonly auth: ResourceNamespace;
  readonly ai: ResourceNamespace;

  /** Installed plugin names. */
  readonly installedPlugins: string[] = [];

  /** SDK version. */
  static readonly version = '0.1.0';

  constructor(config: AstroidClientConfig) {
    super();

    this.http = new ClientHttpClient(config);
    this.sessionManager = this.http.sessionManager;

    // Create resource namespaces
    this.wallets = createResourceNamespace(this.http, '/wallets');
    this.agents = createResourceNamespace(this.http, '/agents');
    this.policies = createResourceNamespace(this.http, '/policies');
    this.budgets = createResourceNamespace(this.http, '/budgets');
    this.transactions = createResourceNamespace(this.http, '/transactions');
    this.notifications = createResourceNamespace(this.http, '/notifications');
    this.analytics = createResourceNamespace(this.http, '/analytics');
    this.webhooks = createResourceNamespace(this.http, '/webhooks');
    this.auth = createResourceNamespace(this.http, '/auth');
    this.ai = createResourceNamespace(this.http, '/ai');

    // Install default middleware
    this.http.use(createCorrelationMiddleware(config.telemetry));
    this.http.use(createErrorParserMiddleware());
    this.http.use(createErrorTranslatorMiddleware());

    // Rate limiter (if configured)
    if (config.rateLimit !== false && config.rateLimit) {
      const opts =
        typeof config.rateLimit === 'object' ? config.rateLimit : undefined;
      this.http.use(createRateLimiterMiddleware(opts));
    }

    // Retry (if not disabled)
    if (config.retry !== false) {
      const retryOpts: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {};
      if (typeof config.retry === 'object' && config.retry !== null) {
        Object.assign(retryOpts, config.retry);
      }
      if (typeof config.retries === 'number') {
        retryOpts.maxRetries = config.retries;
      }
      if (typeof config.retryDelay === 'number') {
        retryOpts.baseDelayMs = config.retryDelay;
      }
      this.http.use(createRetryMiddleware(retryOpts));
    }
  }

  /** Register a custom middleware. */
  use(middleware: Middleware): this {
    this.http.use(middleware);
    return this;
  }

  /** Register a plugin. */
  register(plugin: { name: string; install: (client: Astroid) => void }): this {
    plugin.install(this);
    this.installedPlugins.push(plugin.name);
    return this;
  }

  /** Set a static access token. */
  setAccessToken(token: string): void {
    this.http.setAccessToken(token);
  }

  /** Set a dynamic token provider. */
  setTokenProvider(provider: () => string | Promise<string>): void {
    this.http.setTokenProvider(provider);
  }

  /** Combine pagination and custom query parameters. */
  buildQuery(params: Record<string, any>): Record<string, any> {
    return params;
  }

  /** Perform a raw GET request (returns unwrapped data). */
  async get<T = unknown>(path: string, options?: any): Promise<T> {
    const res = await this.http.get<T>(path, options);
    return unwrapEnvelope<T>(res.data);
  }

  /** Perform a raw POST request (returns unwrapped data). */
  async post<T = unknown>(path: string, body?: unknown, options?: any): Promise<T> {
    const res = await this.http.post<T>(path, body, options);
    return unwrapEnvelope<T>(res.data);
  }

  /** Perform a raw PUT request (returns unwrapped data). */
  async put<T = unknown>(path: string, body?: unknown, options?: any): Promise<T> {
    const res = await this.http.put<T>(path, body, options);
    return unwrapEnvelope<T>(res.data);
  }

  /** Perform a raw DELETE request (returns unwrapped data). */
  async delete<T = unknown>(path: string, options?: any): Promise<T> {
    const res = await this.http.delete<T>(path, options);
    return unwrapEnvelope<T>(res.data);
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience alias                                                           */
/* -------------------------------------------------------------------------- */

export { Astroid as AstroidClient };
