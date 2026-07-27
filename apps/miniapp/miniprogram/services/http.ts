/**
 * Thin wx.request wrapper.
 *
 * Responsibilities:
 *   - Centralize the API base URL (single constant).
 *   - Attach `Authorization: Bearer <accessToken>` when a session exists.
 *   - Surface a canonical {@link ApiError} carrying the server `traceId` so the
 *     UI can show it and so logs are correlatable.
 *   - On HTTP 401 with an access token, transparently attempt ONE refresh via
 *     the refresh token; on refresh failure clear the session and route to the
 *     login page. This keeps the auth concerns out of the page modules.
 *
 * The wrapper is intentionally Promise-based so callers can `await` it; the
 * underlying wx.request callback shape is hidden here.
 */

import { sessionStore } from '../stores/session-store';
import { refreshAccessToken } from './auth';

/**
 * Configurable API base URL. Falls back to a sentinel for tests; production
 * builds override it via the `MINIAPP_API_BASE_URL` build-time constant or by
 * editing this line.
 */
export const API_BASE_URL =
  (typeof process !== 'undefined' && process.env?.MINIAPP_API_BASE_URL) ||
  'http://localhost:3000';

/**
 * Canonical API error thrown by {@link request}. Real class (not just an
 * interface) so callers can use `instanceof ApiError` to distinguish transport
 * errors from business errors and surface the trace id.
 */
export class ApiError extends Error {
  /** Canonical business error code from the API envelope. */
  readonly code: string;
  /** HTTP status code that carried the error. */
  readonly statusCode: number;
  /** Server-issued trace id, preserved end-to-end. */
  readonly traceId?: string;
  /** Optional structured details from the envelope. */
  readonly details?: Record<string, unknown>;
  /**
   * True when the http layer already cleared the session and redirected to
   * login before throwing this error. Page catch blocks should suppress any
   * `wx.showToast` in this case — the toast would flash on the login page (or
   * be dropped) because navigation is already in flight.
   */
  readonly redirected?: boolean;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    traceId?: string,
    details?: Record<string, unknown>,
    redirected?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.traceId = traceId;
    this.details = details;
    this.redirected = redirected;
  }
}

/**
 * True iff `err` is an {@link ApiError} thrown after the http layer already
 * cleared the session and kicked off a redirect to login. Page catch blocks
 * use this to suppress a redundant (and racy) `wx.showToast`.
 */
export function isRedirectedError(err: unknown): boolean {
  return err instanceof ApiError && err.redirected === true;
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path under the API base, e.g. `/api/mini/v1/students`. */
  path: string;
  /** JSON body (serialized automatically). */
  data?: unknown;
  /** When false, skip the Authorization header even if a session exists. */
  auth?: boolean;
  /** Called with the parsed `data` field on a 2xx. */
}

interface WxResponse<T = unknown> {
  statusCode: number;
  data:
    | {
        code: number;
        message: string;
        data: T;
      }
    | {
        code: string;
        message: string;
        traceId?: string;
        details?: Record<string, unknown>;
      };
  header: Record<string, string>;
  cookies: unknown[];
}

function buildUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
}

function toApiError(statusCode: number, body: unknown, redirected = false): ApiError {
  const envelope = (body ?? {}) as {
    code?: string;
    message?: string;
    traceId?: string;
    details?: Record<string, unknown>;
  };
  return new ApiError(
    envelope.message ?? `request failed (${statusCode})`,
    envelope.code ?? `HTTP_${statusCode}`,
    statusCode,
    envelope.traceId,
    envelope.details,
    redirected,
  );
}

function rawRequest<T>(opts: {
  url: string;
  method: NonNullable<RequestOpts['method']>;
  data?: unknown;
  header: Record<string, string>;
}): Promise<WxResponse<T>> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: opts.url,
      // wx.request's type union omits PATCH; our wrapper allows it. The WeChat
      // runtime accepts PATCH fine — only the typings are conservative.
      method: opts.method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      data: opts.data as string | Record<string, unknown> | ArrayBuffer | undefined,
      header: opts.header,
      success: (res: unknown) => resolve(res as WxResponse<T>),
      fail: (err: unknown) => reject(err),
    });
  });
}

/**
 * Issue an authenticated API call. Unwraps the `{code,message,data}` success
 * envelope and returns `data`. Throws {@link ApiError} on any non-2xx.
 */
export async function request<T>(opts: RequestOpts): Promise<T> {
  const method = opts.method ?? 'GET';
  const wantAuth = opts.auth !== false;
  return requestWithRetry<T>(opts.path, method, opts.data, wantAuth, true);
}

async function requestWithRetry<T>(
  path: string,
  method: NonNullable<RequestOpts['method']>,
  data: unknown,
  auth: boolean,
  allowRefresh: boolean,
): Promise<T> {
  const header: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) {
    const token = sessionStore.getAccessToken();
    if (token) header.Authorization = `Bearer ${token}`;
  }

  const res = await rawRequest<T>({
    url: buildUrl(path),
    method,
    data,
    header,
  });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    return (res.data as { data: T }).data;
  }

  if (res.statusCode === 401 && auth && allowRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return requestWithRetry<T>(path, method, data, auth, false);
    }
    // Refresh failed: clear session and route to login. Mark the thrown error
    // so page catch blocks can suppress their toast (it would race with the
    // navigation and flash on the login page, or be dropped entirely).
    sessionStore.clearSession();
    redirectToLogin();
    throw toApiError(res.statusCode, res.data, true);
  }

  throw toApiError(res.statusCode, res.data);
}

function redirectToLogin(): void {
  // reLaunch clears the page stack so the member can't navigateBack into a
  // private page after the session was cleared.
  if (typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
    wx.reLaunch({ url: '/pages/login/index' });
  }
}

/**
 * Fire-and-forget request used by public catalog pages — no Authorization
 * header, no 401→refresh handling. Keeps the public path side-effect free.
 */
export async function publicRequest<T>(opts: Omit<RequestOpts, 'auth'>): Promise<T> {
  return requestWithRetry<T>(opts.path, opts.method ?? 'GET', opts.data, false, false);
}
