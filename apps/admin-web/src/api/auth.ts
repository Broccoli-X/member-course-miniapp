/**
 * Admin authentication API client.
 *
 * Wraps the Task 4 endpoints:
 *   - POST /api/admin/v1/auth/login
 *   - POST /api/admin/v1/auth/refresh
 *   - POST /api/admin/v1/auth/logout
 *
 * Login/refresh/logout all opt out of the transparent 401-refresh handling in
 * the http layer (otherwise refresh would recurse into itself).
 */
import { http } from './http';
import type {
  AdminLoginRequest,
  AdminLoginResponse,
  AdminRefreshRequest,
  AdminRefreshResponse,
  AdminLogoutRequest,
  AdminLogoutResponse,
} from '@member-course/contracts';

export const authApi = {
  login(body: AdminLoginRequest): Promise<AdminLoginResponse> {
    return http.post<AdminLoginResponse>('/admin/v1/auth/login', body, { auth: false });
  },
  refresh(refreshToken: AdminRefreshRequest['refreshToken']): Promise<AdminRefreshResponse> {
    return http.post<AdminRefreshResponse>(
      '/admin/v1/auth/refresh',
      { refreshToken } satisfies AdminRefreshRequest,
      { auth: false, skipRefresh: true },
    );
  },
  logout(refreshToken: AdminLogoutRequest['refreshToken']): Promise<AdminLogoutResponse> {
    return http.post<AdminLogoutResponse>(
      '/admin/v1/auth/logout',
      { refreshToken } satisfies AdminLogoutRequest,
      { skipRefresh: true },
    );
  },
};

export default authApi;
