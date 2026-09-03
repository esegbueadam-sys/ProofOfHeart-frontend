/**
 * Query parameter serialization helper for @astroid/client.
 *
 * Supports strings, numbers, booleans, arrays, and nested objects, while
 * gracefully omitting null, undefined, and empty string/array values.
 */

export type QueryParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryParamValue[]
  | { [key: string]: QueryParamValue };

export type QueryParams = Record<string, QueryParamValue>;

/**
 * Serializes an object of query parameters into a URL-encoded query string.
 * Omits keys with null or undefined values, and flattens arrays/objects correctly.
 */
export function serializeQuery(params?: QueryParams): string {
  if (!params) {
    return '';
  }

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    appendParam(searchParams, key, value);
  }

  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

function appendParam(searchParams: URLSearchParams, key: string, value: QueryParamValue): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item !== null && item !== undefined && item !== '') {
        searchParams.append(`${key}[${i}]`, String(item));
      }
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [subKey, subVal] of Object.entries(value)) {
      appendParam(searchParams, `${key}[${subKey}]`, subVal);
    }
    return;
  }

  if (value === '') {
    return;
  }

  searchParams.append(key, String(value));
}