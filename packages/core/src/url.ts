/**
 * URL construction and query-string serialisation.
 */

import type { QueryValue } from './http-types.js';

/**
 * Serialise a query map into a URLSearchParams-backed string. Arrays repeat the
 * key (`?tag=a&tag=b`); `undefined`/`null` values are dropped; booleans/numbers
 * are stringified.
 */
export function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Join the base URL, version, and path into a full request URL.
 *
 * @example buildUrl('https://api.astroid.finance', 'v1', '/wallets', { limit: 10 })
 *   // "https://api.astroid.finance/v1/wallets?limit=10"
 */
export function buildUrl(
  baseUrl: string,
  apiVersion: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const cleanVersion = apiVersion.replace(/^\/|\/$/g, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const versionSegment = cleanVersion ? `/${cleanVersion}` : '';
  return `${cleanBase}${versionSegment}${cleanPath}${buildQueryString(query)}`;
}

/**
 * Combines a base URL and relative URL cleanly without trailing/leading slashes overlap.
 */
export function combineUrl(baseUrl: string, relativeUrl?: string): string {
  if (!relativeUrl) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${relativeUrl.replace(/^\/+/, '')}`;
}