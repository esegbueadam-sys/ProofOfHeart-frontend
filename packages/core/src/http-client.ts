export const SDK_VERSION = '1.0.0';
import { AstroidTimeoutError } from './timeout-error.js';
import type { HttpClientOptions, HttpRequestOptions, HttpResponse } from './http-types.js';
import { combineUrl, buildQueryString } from './url.js';

export class HttpClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeout ?? options.timeoutMs ?? 30000;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const path = options.path ?? '';
    const rawUrl = combineUrl(this.baseUrl, path);
    const queryStr = buildQueryString(options.query ?? options.params);
    const url = queryStr ? `${rawUrl}${queryStr}` : rawUrl;

    const method = options.method ?? 'GET';
    const headers = {
      ...this.defaultHeaders,
      ...options.headers,
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }
    }

    const timeout = options.timeout ?? this.timeoutMs;
    const controller = new AbortController();
    const externalSignal = options.signal;

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', () => {
          controller.abort(externalSignal.reason);
        }, { once: true });
      }
    }

    const timer = setTimeout(() => {
      controller.abort(new AstroidTimeoutError(timeout));
    }, timeout);

    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      let responseBody: unknown;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        responseBody = await response.json().catch(() => undefined);
      } else {
        responseBody = await response.text().catch(() => undefined);
      }

      const requestId = response.headers.get('x-request-id') || response.headers.get('x-correlation-id') || undefined;

      return {
        status: response.status,
        headers: response.headers,
        body: responseBody as T,
        data: responseBody as T,
        requestId,
      };
    } catch (error: any) {
      clearTimeout(timer);
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof AstroidTimeoutError) {
          throw reason;
        }
        throw new AstroidTimeoutError(timeout);
      }
      throw error;
    }
  }

  public async get<T = unknown>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'path'>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'GET', path });
  }

  public async post<T = unknown>(path: string, body?: unknown, options?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'POST', path, body });
  }

  public async put<T = unknown>(path: string, body?: unknown, options?: Omit<HttpRequestOptions, 'method' | 'path' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'PUT', path, body });
  }

  public async delete<T = unknown>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'path'>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...options, method: 'DELETE', path });
  }
}