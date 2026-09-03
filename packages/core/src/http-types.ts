export interface HttpClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, any>;
  params?: Record<string, any>;
  timeout?: number;
  signal?: AbortSignal;
  retryable?: boolean;
  correlationId?: string;
  options?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  data: T;
  meta?: Record<string, any>;
  requestId?: string;
}

export interface AstroidResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  body?: T;
  meta?: Record<string, any>;
  requestId?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined | QueryValue[];

export type RequestOptions = HttpRequestOptions;

export interface PreparedRequest {
  url: string;
  method: string;
  headers: any;
  init: RequestInit;
  options: Record<string, any>;
  retryable?: boolean;
  params?: Record<string, any>;
  body?: any;
  signal?: AbortSignal;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  data: any;
  requestId?: string;
}

export interface ErrorPayload {
  message: string;
  code?: string;
  details?: any;
}

export type MiddlewareFunction = (
  req: PreparedRequest,
  next: () => Promise<RawResponse>
) => Promise<RawResponse>;

export interface MiddlewareObject {
  name?: string;
  onRequest?: (req: PreparedRequest) => any;
  onResponse?: (res: RawResponse, req: PreparedRequest) => any;
  onError?: (error: any, req: PreparedRequest) => any;
  [key: string]: any;
}

export type Middleware = MiddlewareFunction | MiddlewareObject;

export type MiddlewareStack = Middleware[];