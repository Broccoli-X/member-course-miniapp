import {
  type AdminLogoutRequest,
  type AdminLogoutResponse,
} from '@member-course/contracts';

/** DTO for `POST /api/admin/v1/auth/logout`. */
export class AdminLogoutDto implements AdminLogoutRequest {
  refreshToken!: string;
}

export type AdminLogoutResponseDto = AdminLogoutResponse;
