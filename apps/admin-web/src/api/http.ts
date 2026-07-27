/**
 * Admin-web HTTP client.
 *
 * A small `fetch` wrapper (axios is intentionally not a dependency). It:
 *   - prefixes every request with `/api`,
 *   - attaches `Authorization: Bearer <accessToken>` when a token is present,
 *   - on a 401, performs a SINGLE queued refresh and transparently retries the
 *     original request once; concurrent 401s share the same refresh promise,
 *   - on refresh failure (or when there is no refresh token), clears the tokens
 *     and bounces the user back to `/login`,
 *   - preserves the server error envelope `{code, message, traceId, details?}`
 *     by throwing {@link ApiError} with the exact `message` and `traceId`.
 *
 * The token source/refresh logic is injected via {@link TokenProvider} so this
 * module never imports the Pinia store directly (avoids a circular import:
 * the store imports `api/auth`, which imports `http`).
 */

/** Server error envelope (produced by the API's global exception filter). */
export interface ApiErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly traceId: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Error thrown for any non-2xx API response. Carries the verbatim server
 * `message` and `traceId` so the UI can surface them exactly (global
 * constraint: preserve exact API error messages and trace IDs).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly traceId: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    traceId: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = traceId;
    this.status = status;
    this.details = details;
  }
}

/** Shape the auth store implements so http can read/rotate/clear tokens. */
export interface TokenProvider {
  /** Current access token (in-memory) or null. */
  getAccessToken(): string | null;
  /** Current refresh token (persisted) or null. */
  getRefreshToken(): string | null;
  /**
   * Perform exactly one refresh. Concurrent callers MUST share one in-flight
   * promise (the default implementation below dedupes).
   */
  refresh(): Promise<string>;
  /** Clear both tokens (refresh failure / logout). */
  clear(): void;
}

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Record<string, string | number | boolean | undefined>;
  /** Request body — serialized as JSON. */
  readonly body?: unknown;
  /** Set false to skip the auth header (e.g. the login call itself). */
  readonly auth?: boolean;
  /** Set true to opt out of the transparent 401-retry (used by refresh itself). */
  readonly skipRefresh?: boolean;
  /**
   * Extra request headers (merged on top of the JSON/auth defaults). Used to
   * pass the `Idempotency-Key` header on confirm/reverse/void calls so a
   * doubled submit executes the work exactly once.
   */
  readonly headers?: Record<string, string>;
}

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/** Build a query string, dropping undefined/null values. */
function buildQuery(params?: HttpRequestOptions['query']): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  const search = new URLSearchParams();
  for (const [k, v] of entries) search.set(k, String(v));
  return '?' + search.toString();
}

/** Read the error envelope from a non-2xx response, falling back sensibly. */
async function readErrorEnvelope(response: Response): Promise<ApiErrorEnvelope> {
  const fallback = {
    code: 'INTERNAL_ERROR',
    message: response.statusText || `请求失败 (${response.status})`,
    traceId: 'unknown',
  };
  try {
    const text = await response.text();
    if (!text) return fallback;
    const parsed = JSON.parse(text) as Partial<ApiErrorEnvelope>;
    return {
      code: parsed.code ?? fallback.code,
      message: parsed.message ?? fallback.message,
      traceId: parsed.traceId ?? fallback.traceId,
      ...(parsed.details ? { details: parsed.details } : {}),
    };
  } catch {
    return fallback;
  }
}

// ── Token provider wiring ──────────────────────────────────────────────────

let tokenProvider: TokenProvider | null = null;

/** Registered by the auth store at app bootstrap. */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

// ── Refresh deduplication ──────────────────────────────────────────────────

let inflightRefresh: Promise<string> | null = null;

async function doRefreshOnce(provider: TokenProvider): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = provider
    .refresh()
    .finally(() => {
      inflightRefresh = null;
    });
  return inflightRefresh;
}

/**
 * Redirect to /login. Uses `window.location` when the SPA router is not
 * available (e.g. during bootstrap), which is fine because there is nothing
 * stateful to preserve on the login screen.
 */
function redirectToLogin(): void {
  tokenProvider?.clear();
  if (typeof window !== 'undefined' && window.location) {
    const current = window.location.pathname + window.location.search;
    if (current !== '/login') {
      window.location.assign('/login');
    }
  }
}

// ── Core request ───────────────────────────────────────────────────────────

export async function request<T>(path: string, options: HttpRequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    query,
    body,
    auth = true,
    skipRefresh = false,
    headers: extraHeaders,
  } = options;

  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (auth && tokenProvider) {
    const at = tokenProvider.getAccessToken();
    if (at) headers.Authorization = `Bearer ${at}`;
  }
  // Caller-supplied headers win over the JSON/auth defaults (e.g. the
  // Idempotency-Key that makes confirm/reverse replay-safe).
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(`/api${path}${buildQuery(query)}`, init);

  if (!response.ok) {
    const envelope = await readErrorEnvelope(response);

    // Transparent refresh-on-401. Only attempted for authenticated requests
    // that did not already opt out (the refresh call itself opts out).
    if (response.status === 401 && auth && !skipRefresh && tokenProvider) {
      const refreshToken = tokenProvider.getRefreshToken();
      if (refreshToken) {
        try {
          const newAccessToken = await doRefreshOnce(tokenProvider);
          headers.Authorization = `Bearer ${newAccessToken}`;
          const retryResponse = await fetch(`/api${path}${buildQuery(query)}`, {
            ...init,
            headers,
          });
          if (retryResponse.ok) {
            return (await retryResponse.json()) as T;
          }
          const retryEnvelope = await readErrorEnvelope(retryResponse);
          throw new ApiError(
            retryEnvelope.code,
            retryEnvelope.message,
            retryEnvelope.traceId,
            retryResponse.status,
            retryEnvelope.details,
          );
        } catch (err) {
          if (err instanceof ApiError) throw err;
          // Refresh failed: clear and bounce to login.
          redirectToLogin();
          throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录', 'unknown', 401);
        }
      } else {
        // No refresh token available — cannot recover.
        redirectToLogin();
      }
    }

    throw new ApiError(
      envelope.code,
      envelope.message,
      envelope.traceId,
      response.status,
      envelope.details,
    );
  }

  // 204 No Content has no body to parse.
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Convenience verb helpers.
export const http = {
  get: <T>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<HttpRequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<HttpRequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<HttpRequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
