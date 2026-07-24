import {
  type MemberRefreshRequest,
  type MemberRefreshResponse,
  type MemberLogoutRequest,
  type MemberLogoutResponse,
} from '@member-course/contracts';

/** DTO for `POST /api/mini/v1/auth/refresh`. */
export class MiniRefreshDto implements MemberRefreshRequest {
  refreshToken!: string;
}

export type MiniRefreshResponseDto = MemberRefreshResponse;

/** DTO for `POST /api/mini/v1/auth/logout`. */
export class MiniLogoutDto implements MemberLogoutRequest {
  refreshToken!: string;
}

export type MiniLogoutResponseDto = MemberLogoutResponse;
