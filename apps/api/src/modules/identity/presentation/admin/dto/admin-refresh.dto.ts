import {
  type AdminRefreshRequest,
  type AdminRefreshResponse,
} from '@member-course/contracts';

/** DTO for `POST /api/admin/v1/auth/refresh`. */
export class AdminRefreshDto implements AdminRefreshRequest {
  refreshToken!: string;
}

export type AdminRefreshResponseDto = AdminRefreshResponse;
