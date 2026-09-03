// Re-export types from http-types
export type {
  HttpClientOptions,
  HttpRequestOptions,
  HttpResponse,
  AstroidResponse,
  HttpMethod,
  QueryValue,
  RequestOptions,
  PreparedRequest,
  RawResponse,
  ErrorPayload,
  MiddlewareFunction,
  MiddlewareObject,
  Middleware,
  MiddlewareStack,
} from './http-types.js';

// Re-export core classes and functions
export { HttpClient } from './http-client.js';
export { Resource } from './resource.js';
export { buildQueryString, combineUrl } from './url.js';
export { AstroidTimeoutError } from './timeout-error.js';
export type { RetryConfig, TelemetryHooks } from './config.js';

// Re-export middleware utilities
export {
  loggingMiddleware,
  headerMiddleware,
  createRetryMiddleware,
  retryMiddleware,
  redactHeaders,
} from './middleware.js';
export type { RetryMiddlewareOptions, LogEntry, LogSink } from './middleware.js';

// Re-export pagination
export {
  paginate,
  collect,
} from './pagination.js';
export type { PageFetcher } from './pagination.js';

// Re-export backoff utilities
export {
  backoffDelay,
  isRetryableStatus,
} from './backoff.js';

// Re-export offline queue
export { OfflineQueue } from './offline-queue.js';

// Re-export SDK version
export { SDK_VERSION } from './http-client.js';